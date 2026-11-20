#!/usr/bin/env python3
"""Multi-camera soak / stress test for vision-worker.

Starts MediaMTX, N ffmpeg publishers (synthetic lavfi test patterns, H.264,
like N IP cameras), and ONE vision-worker reading all N cameras. Samples, for
the measured window:

  * per process group: CPU % (of one core; 400% = all 4 cores) and RSS for
    vision-worker, MediaMTX and the ffmpeg publishers (reported separately,
    because the publishers share the machine but would not run on a real edge
    box);
  * host CPU %;
  * per camera from vision-worker /status: decoded fps, sampled fps,
    analyzed fps (sampled - dropped), frames_dropped_total, decode errors,
    reconnects, state.

Optional fault injection kills one publisher mid-run, measures how long the
worker takes to report RECONNECTING, restarts it, and measures recovery to
STREAMING. It runs in a background thread, so sampling continues during the
fault.

Cameras are split into priority cameras (register/POS, sampled at 15 fps;
this flag was called `protected` before the restaurant pivot) and normal
cameras (5 fps).

Summary statistics are weighted by sample-interval duration. Counters are
reported twice: `window` covers only the measured window; `whole_run` is the
worker's lifetime totals (including connect and warm-up).

  uv run python soak.py --cameras 8 --resolution 640x360 --duration 60 --detector mock --out results/n8.json

Synthetic patterns only: no footage, no people.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import psutil

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
VISION = REPO / "services" / "vision-worker"

# Cheap-to-generate lavfi sources with different content/motion, so the
# encoder and decoder see varied bitstreams.
PATTERNS = [
    "testsrc2=size={s}:rate={r}",
    "smptehdbars=size={s}:rate={r}",
    "testsrc=size={s}:rate={r}",
    "rgbtestsrc=size={s}:rate={r}",
    "life=size={s}:rate={r}:mold=10:ratio=0.2:death_color=#C83232:life_color=#00ff00",
    "cellauto=size={s}:rate={r}:rule=110",
    "yuvtestsrc=size={s}:rate={r}",
    "pal100bars=size={s}:rate={r}",
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_open(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_for(cond, timeout: float, step: float = 0.1) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(step)
    return False


def get_json(url: str, timeout: float = 3.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


class Group:
    """CPU/RSS of a process and all its descendants."""

    def __init__(self, name: str):
        self.name = name
        self.roots: list[psutil.Process] = []
        self._seen: dict[int, psutil.Process] = {}

    def add(self, pid: int):
        try:
            self.roots.append(psutil.Process(pid))
        except psutil.NoSuchProcess:
            pass

    def replace(self, old_pid: int | None, new_pid: int):
        """Swap a restarted process in: drop the old root, add the new one."""
        self.roots = [r for r in self.roots if r.pid != old_pid]
        self.add(new_pid)

    def procs(self) -> list[psutil.Process]:
        out = []
        for r in self.roots:
            try:
                if r.is_running():
                    out.append(r)
                    out += r.children(recursive=True)
            except psutil.NoSuchProcess:
                pass
        return out

    def sample(self) -> tuple[float, float]:
        """(cpu %, rss MB) since the previous call. Processes keep their psutil
        object so cpu_percent() measures the interval since the last call."""
        cpu = rss = 0.0
        for p in self.procs():
            p = self._seen.setdefault(p.pid, p)
            try:
                c = p.cpu_percent(None)
                rss += p.memory_info().rss / 2**20
                cpu += c
            except psutil.NoSuchProcess:
                self._seen.pop(p.pid, None)
        return cpu, rss


class Publisher:
    def __init__(self, url: str, pattern: str, gop: int, log: Path):
        self.url, self.pattern, self.gop, self.log = url, pattern, gop, log
        self.proc: subprocess.Popen | None = None
        self.closed = False  # set at cleanup: a late restart from the fault thread must not leak ffmpeg

    def start(self):
        if self.closed:
            return self
        self.proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", self.pattern,
             "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", str(self.gop),
             "-pix_fmt", "yuv420p", "-f", "rtsp", "-rtsp_transport", "tcp", self.url],
            stdout=subprocess.DEVNULL, stderr=open(self.log, "a"), start_new_session=True)
        return self

    def stop(self, sig=signal.SIGTERM):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, sig)
                self.proc.wait(10)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.proc = None


def machine() -> dict:
    model = ""
    try:
        model = next(l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name"))
    except Exception:  # noqa: BLE001
        pass
    ff = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    return {"cpu_model": model, "logical_cpus": psutil.cpu_count(), "physical_cpus": psutil.cpu_count(logical=False),
            "ram_gb": round(psutil.virtual_memory().total / 2**30, 1), "kernel": platform.release(),
            "python": platform.python_version(), "ffmpeg": ff, "gpu": _gpu()}


def _gpu() -> str:
    try:
        return subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True, timeout=5).stdout.strip() or "none"
    except Exception:  # noqa: BLE001
        return "none"


def run(a) -> dict:
    out_dir = Path(a.out).resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(a.out).resolve().with_suffix("")
    work.mkdir(parents=True, exist_ok=True)
    rtsp_port, api_port, health_port = free_port(), free_port(), free_port()
    (work / "mediamtx.yml").write_text(
        f"logLevel: warn\nrtspAddress: 127.0.0.1:{rtsp_port}\nrtsp: yes\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\n"
        f"api: yes\napiAddress: 127.0.0.1:{api_port}\nmetrics: no\npprof: no\nplayback: no\n"
        "paths:\n  all_others:\n")
    n_prio = round(a.cameras * a.priority_fraction)
    cams = []
    for i in range(a.cameras):
        cams.append({"id": f"cam{i + 1:02d}", "url": f"rtsp://127.0.0.1:{rtsp_port}/cam{i + 1:02d}",
                     "priority": i < n_prio})
    (work / "cameras.json").write_text(json.dumps({"cameras": cams}, indent=2))

    pubs = [Publisher(c["url"], PATTERNS[i % len(PATTERNS)].format(s=a.resolution, r=a.input_fps), a.input_fps,
                      work / f"ffmpeg-{c['id']}.log") for i, c in enumerate(cams)]
    mtx = wk = None
    g_worker, g_mtx, g_pub = Group("vision-worker"), Group("mediamtx"), Group("ffmpeg publishers")
    result: dict = {"machine": machine(), "params": vars(a), "cameras": cams}

    def cleanup(*_):
        for p in pubs:
            p.closed = True
            p.stop()
        for proc in (wk, mtx):
            if proc and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(15)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    signal.signal(signal.SIGTERM, lambda *_: (cleanup(), sys.exit(143)))
    # Other workloads on a shared machine distort host CPU: record them first.
    psutil.cpu_percent(None)
    time.sleep(3)
    result["baseline_host_cpu_pct"] = psutil.cpu_percent(None)
    result["loadavg_before"] = os.getloadavg()
    try:
        mtx = subprocess.Popen([a.mediamtx, str(work / "mediamtx.yml")], start_new_session=True,
                               stdout=open(work / "mediamtx.log", "w"), stderr=subprocess.STDOUT)
        g_mtx.add(mtx.pid)
        if not wait_for(lambda: port_open(rtsp_port) and port_open(api_port), 15):
            raise RuntimeError("MediaMTX did not start")
        for p in pubs:
            p.start()
            g_pub.add(p.proc.pid)

        def ready_paths():
            items = get_json(f"http://127.0.0.1:{api_port}/v3/paths/list").get("items", [])
            return sum(1 for it in items if it.get("ready"))
        if not wait_for(lambda: ready_paths() == a.cameras, 30, 0.5):
            raise RuntimeError(f"only {ready_paths()} of {a.cameras} publishers became ready")

        cmd = ["uv", "run", "--project", str(VISION), "zeoatap-vision", "--config", str(work / "cameras.json"),
               "--observations", os.devnull if not a.keep_observations else str(work / "observations.jsonl"),
               "--detector", a.detector, "--health-port", str(health_port), *a.worker_arg]
        result["worker_cmd"] = cmd
        wk = subprocess.Popen(cmd, start_new_session=True, stdout=subprocess.DEVNULL,
                              stderr=open(work / "vision-worker.log", "w"))
        g_worker.add(wk.pid)
        st_url = f"http://127.0.0.1:{health_port}/status"
        t_start = time.time()
        if not wait_for(lambda: all(c["state"] == "STREAMING" for c in get_json(st_url)["cameras"]), a.connect_timeout, 0.5):
            raise RuntimeError("not every camera reached STREAMING")
        result["connect_s"] = round(time.time() - t_start, 2)
        time.sleep(a.warmup)

        psutil.cpu_percent(None)
        for g in (g_worker, g_mtx, g_pub):
            g.sample()
        prev = {c["camera_id"]: c for c in get_json(st_url)["cameras"]}
        t_prev = time.time()
        samples, fault = [], {}
        fault_cam = cams[a.fault_camera]["id"] if a.fault_at is not None else None
        fault_thread: threading.Thread | None = None
        t0 = time.time()
        while time.time() - t0 < a.duration:
            elapsed = time.time() - t0
            if a.fault_at is not None and fault_thread is None and elapsed >= a.fault_at:
                # In the background: the sampling loop must keep running during the fault.
                fault_thread = threading.Thread(target=_inject_fault, daemon=True,
                                                args=(pubs[a.fault_camera], fault_cam, st_url, a, g_pub, fault))
                fault_thread.start()
            time.sleep(max(0.0, a.interval - ((time.time() - t0) % a.interval)))
            now = time.time()
            st = get_json(st_url)
            dt = now - t_prev
            host = psutil.cpu_percent(None)
            row = {"t": round(now - t0, 2), "dt": round(dt, 3), "host_cpu_pct": host,
                   "host_cpu_cores_busy": round(host / 100 * psutil.cpu_count(), 2)}
            for g in (g_worker, g_mtx, g_pub):
                c, r = g.sample()
                row[g.name] = {"cpu_pct": round(c, 1), "rss_mb": round(r, 1)}
            per = {}
            for c in st["cameras"]:
                p = prev.get(c["camera_id"], c)
                d = lambda k: c[k] - p[k]  # noqa: E731
                per[c["camera_id"]] = {
                    "state": c["state"], "decoded_fps": round(d("frames_decoded_total") / dt, 2),
                    "sampled_fps": round(d("frames_sampled_total") / dt, 2),
                    "analyzed_fps": round((d("frames_sampled_total") - d("frames_dropped_total")) / dt, 2),
                    "sampled": d("frames_sampled_total"),
                    "dropped": d("frames_dropped_total"), "decode_errors": d("decode_errors_total"),
                    "reconnects": d("reconnects_total")}
            row["cameras"] = per
            row["observations_written"] = st.get("observations_written")
            samples.append(row)
            prev, t_prev = {c["camera_id"]: c for c in st["cameras"]}, now
        if fault_thread is not None:
            fault_thread.join(a.fault_down_s + 120)
            if fault_thread.is_alive():
                fault["error"] = "fault injection still running when the window ended"
        final = get_json(st_url)
        result["loadavg_after"] = os.getloadavg()
        result.update(samples=samples, fault=dict(fault) or None, final_status=final,
                      summary=_summarize(samples, cams, final, fault_cam, a))
    finally:
        cleanup()
    Path(a.out).write_text(json.dumps(result, indent=2))
    return result


def _inject_fault(pub: Publisher, cam_id: str, st_url: str, a, group: Group, f: dict) -> dict:
    """Kill one publisher (camera unplugged), time RECONNECTING, restart it after
    fault_down_s, time STREAMING again. Fills `f` in place (it runs in a
    background thread) and puts the restarted publisher back in `group` so its
    CPU/RSS keep being measured."""
    killed = time.time()
    f.update(camera=cam_id, killed_at=round(killed, 3))
    old_pid = pub.proc.pid if pub.proc else None
    pub.stop(signal.SIGKILL)
    state = lambda: next(c for c in get_json(st_url)["cameras"] if c["camera_id"] == cam_id)  # noqa: E731
    if wait_for(lambda: state()["state"] == "RECONNECTING", 30, 0.05):
        f["to_reconnecting_s"] = round(time.time() - killed, 2)
    time.sleep(max(0.0, a.fault_down_s - (time.time() - killed)))
    pub.start()
    if pub.proc is None:  # the run is being cleaned up
        return f
    group.replace(old_pid, pub.proc.pid)
    restarted = time.time()
    f["restarted_at"] = round(restarted, 3)
    if wait_for(lambda: state()["state"] == "STREAMING", 60, 0.05):
        f["recovery_after_restart_s"] = round(time.time() - restarted, 2)
    try:
        f["reconnects_total"] = state()["reconnects_total"]
    except Exception as e:  # noqa: BLE001
        f["error"] = f"could not read /status: {e}"
    return f


def _wmean(pairs) -> float:
    """Mean of (value, weight) pairs weighted by weight (interval seconds)."""
    pairs = list(pairs)
    tw = sum(w for _, w in pairs)
    return statistics.fmean(v for v, _ in pairs) if tw <= 0 else sum(v * w for v, w in pairs) / tw


def _summarize(samples, cams, final, fault_cam, a) -> dict:
    dts = [r.get("dt", a.interval) for r in samples]

    def stat(vals):
        """Interval-weighted mean, plus the min and max sample."""
        vals = list(vals)
        return {"mean": round(_wmean(zip(vals, dts)), 2), "min": round(min(vals), 2),
                "max": round(max(vals), 2)} if vals else None

    s = {k: {"cpu_pct": stat(r[k]["cpu_pct"] for r in samples),
             "rss_mb_max": max((r[k]["rss_mb"] for r in samples), default=None)}
         for k in ("vision-worker", "mediamtx", "ffmpeg publishers")}
    s["host_cpu_pct"] = stat(r["host_cpu_pct"] for r in samples)
    prio = [c["id"] for c in cams if c["priority"]]
    base = [c["id"] for c in cams if not c["priority"]]

    def fps(ids, key, skip_fault=True):
        ids = [i for i in ids if not (skip_fault and i == fault_cam)]
        if not ids or not samples:
            return None
        per_cam = [_wmean((r["cameras"][i][key], dt) for r, dt in zip(samples, dts)) for i in ids]
        return {"mean": round(statistics.fmean(per_cam), 2), "min_camera": round(min(per_cam), 2)}

    def worst_interval(ids):
        vals = [r["cameras"][i]["analyzed_fps"] for r in samples for i in ids if i != fault_cam]
        return round(min(vals), 2) if vals else None

    s["priority"] = {"n": len(prio), "target_fps": 15.0, "sampled_fps": fps(prio, "sampled_fps"),
                     "analyzed_fps": fps(prio, "analyzed_fps"), "worst_interval_analyzed_fps": worst_interval(prio)}
    s["normal"] = {"n": len(base), "target_fps": 5.0, "sampled_fps": fps(base, "sampled_fps"),
                   "analyzed_fps": fps(base, "analyzed_fps"), "worst_interval_analyzed_fps": worst_interval(base)}
    s["decoded_fps"] = fps([c["id"] for c in cams], "decoded_fps")
    s["input_fps"] = a.input_fps

    # Measured window only: sums of the per-interval counter deltas.
    win = lambda k: sum(r["cameras"][c["id"]].get(k, 0) for r in samples for c in cams)  # noqa: E731
    w = {"duration_s": round(sum(dts), 2), "frames_sampled": win("sampled"), "frames_dropped": win("dropped"),
         "decode_errors": win("decode_errors"), "reconnects": win("reconnects")}
    w["drop_rate"] = round(w["frames_dropped"] / w["frames_sampled"], 4) if w["frames_sampled"] else None
    s["window"] = w
    # Worker lifetime totals from the final /status: include connect and warm-up.
    tot = lambda k: sum(c[k] for c in final["cameras"])  # noqa: E731
    run = {k: tot(k) for k in ("frames_sampled_total", "frames_dropped_total", "decode_errors_total",
                               "reconnects_total", "frames_decoded_total")}
    run["drop_rate"] = round(run["frames_dropped_total"] / max(1, run["frames_sampled_total"]), 4)
    run["frames_analyzed_total"] = final.get("frames_analyzed_total")  # detector calls; degraded frames skip it
    s["whole_run"] = run
    s["not_streaming_samples"] = sum(1 for r in samples for c, v in r["cameras"].items()
                                     if v["state"] != "STREAMING" and c != fault_cam)
    return s


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cameras", type=int, default=4)
    ap.add_argument("--resolution", default="640x360", help="e.g. 640x360 or 1280x720")
    ap.add_argument("--input-fps", type=int, default=25, help="publisher frame rate (GOP = 1 s)")
    ap.add_argument("--priority-fraction", type=float, default=0.5,
                    help="fraction of cameras marked priority (register/POS, 15 fps); the rest are sampled at 5 fps")
    ap.add_argument("--detector", default="mock", help="zeoatap-vision --detector value")
    ap.add_argument("--worker-arg", action="append", default=[], help="extra zeoatap-vision argument, repeatable")
    ap.add_argument("--duration", type=float, default=60, help="measured window (s)")
    ap.add_argument("--warmup", type=float, default=10, help="seconds after all cameras stream, before measuring")
    ap.add_argument("--interval", type=float, default=2.0, help="sampling interval (s)")
    ap.add_argument("--connect-timeout", type=float, default=120)
    ap.add_argument("--fault-at", type=float, help="kill one publisher this many seconds into the window")
    ap.add_argument("--fault-camera", type=int, default=0, help="index of the camera to kill (0 = first, priority)")
    ap.add_argument("--fault-down-s", type=float, default=8.0, help="how long the camera stays unplugged")
    ap.add_argument("--keep-observations", action="store_true")
    ap.add_argument("--mediamtx", default=os.environ.get("MEDIAMTX_BIN") or str(REPO / ".tools" / "mediamtx"))
    ap.add_argument("--out", required=True, help="result JSON path")
    a = ap.parse_args()
    r = run(a)
    s = r["summary"]
    print(json.dumps({"cameras": a.cameras, "resolution": a.resolution, "detector": a.detector, **s,
                      "fault": r["fault"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
