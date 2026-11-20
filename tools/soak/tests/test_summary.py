import json
import threading
from pathlib import Path
from types import SimpleNamespace

import soak
import summarize

RESULTS = Path(__file__).parents[1] / "results"


def _cam(f, d, state="STREAMING"):
    return {"state": state, "decoded_fps": 25.0, "sampled_fps": f, "analyzed_fps": f - d,
            "sampled": round(f * 2), "dropped": d, "decode_errors": 0, "reconnects": 0}


def _row(t, fps_p, fps_n, dropped=0, dt=2.0, cpu=20.0):
    return {"t": t, "dt": dt, "host_cpu_pct": 50.0, "vision-worker": {"cpu_pct": cpu, "rss_mb": 100.0},
            "mediamtx": {"cpu_pct": 2.0, "rss_mb": 20.0}, "ffmpeg publishers": {"cpu_pct": 30.0, "rss_mb": 50.0},
            "cameras": {"c1": _cam(fps_p, dropped), "c2": _cam(fps_n, 0)}}


def _final(d1=3):
    return {"frames_analyzed_total": 150,
            "cameras": [{"camera_id": c, "frames_sampled_total": 100, "frames_dropped_total": d,
                         "decode_errors_total": 0, "reconnects_total": 0, "frames_decoded_total": 250}
                        for c, d in (("c1", d1), ("c2", 0))]}


A = SimpleNamespace(input_fps=25, interval=2.0)


def test_summary_separates_priority_and_normal_cameras_and_counts_drops():
    cams = [{"id": "c1", "priority": True}, {"id": "c2", "priority": False}]
    s = soak._summarize([_row(2, 15.0, 5.0), _row(4, 14.0, 5.0, dropped=2)], cams, _final(), None, A)
    assert s["priority"]["sampled_fps"]["mean"] == 14.5
    assert s["priority"]["worst_interval_analyzed_fps"] == 12.0
    assert s["normal"]["analyzed_fps"]["mean"] == 5.0
    assert s["vision-worker"]["cpu_pct"]["mean"] == 20.0
    # Window counters and whole-run counters are kept apart.
    assert s["window"]["frames_dropped"] == 2 and s["window"]["frames_sampled"] == 30 + 28 + 10 + 10
    assert s["window"]["drop_rate"] == round(2 / 78, 4) and s["window"]["duration_s"] == 4.0
    assert s["whole_run"]["frames_dropped_total"] == 3 and s["whole_run"]["drop_rate"] == 0.015
    assert s["whole_run"]["frames_analyzed_total"] == 150


def test_summary_stats_are_weighted_by_interval_duration():
    # A 16 s interval (e.g. a stall) must weigh 8x a 2 s one.
    cams = [{"id": "c1", "priority": True}, {"id": "c2", "priority": False}]
    rows = [_row(2, 15.0, 5.0, cpu=10.0), _row(18, 1.0, 5.0, dt=16.0, cpu=100.0)]
    s = soak._summarize(rows, cams, _final(), None, A)
    assert s["priority"]["sampled_fps"]["mean"] == round((15 * 2 + 1 * 16) / 18, 2)
    assert s["vision-worker"]["cpu_pct"]["mean"] == 90.0
    assert s["vision-worker"]["cpu_pct"]["min"] == 10.0 and s["vision-worker"]["cpu_pct"]["max"] == 100.0


def test_summary_with_one_camera_has_an_empty_group():
    cams = [{"id": "c1", "priority": False}]
    row = _row(2, 5.0, 5.0)
    del row["cameras"]["c2"]
    final = {"cameras": _final()["cameras"][:1]}
    s = soak._summarize([row], cams, final, None, A)
    assert s["priority"]["n"] == 0 and s["priority"]["analyzed_fps"] is None
    assert s["priority"]["worst_interval_analyzed_fps"] is None
    line = summarize.row({"params": {"detector": "mock", "resolution": "640x360", "cameras": 1},
                          "summary": s, "baseline_host_cpu_pct": 1.0})
    assert "– / – / –" in line and "| 5.00 / 5.00 |" in line


def test_summarize_reads_pre_pivot_results(capsys):
    paths = sorted(str(p) for p in RESULTS.glob("*.json"))
    assert paths
    summarize.main(paths)
    out = capsys.readouterr().out
    assert "| mock | 640x360 | 32 |" in out and "| 277 | 0 | 0 |" in out
    old = json.loads((RESULTS / "mock-640x360-n32.json").read_text())
    assert "protected" in old["summary"]  # old key; summarize maps it to the priority column
    assert "14.08 / 13.55 / 9.5" in summarize.row(old)


def test_fault_restart_rejoins_the_publisher_group(monkeypatch):
    calls = []

    class FakeProc:
        def __init__(self, pid):
            self.pid = pid

    class FakePub:
        proc = FakeProc(101)

        def stop(self, sig=None):
            self.proc = None

        def start(self):
            self.proc = FakeProc(202)
            return self

    states = iter(["RECONNECTING", "STREAMING"])
    monkeypatch.setattr(soak, "get_json", lambda url: {"cameras": [
        {"camera_id": "cam01", "state": next(states, "STREAMING"), "reconnects_total": 2}]})
    g = soak.Group("ffmpeg publishers")
    monkeypatch.setattr(g, "replace", lambda old, new: calls.append((old, new)))
    f: dict = {}
    t = threading.Thread(target=soak._inject_fault,
                         args=(FakePub(), "cam01", "http://x", SimpleNamespace(fault_down_s=0.0), g, f))
    t.start()
    t.join(10)
    assert not t.is_alive()
    assert calls == [(101, 202)]
    assert f["camera"] == "cam01" and "to_reconnecting_s" in f and "recovery_after_restart_s" in f
    assert f["reconnects_total"] == 2


def test_cli_uses_priority_naming():
    import inspect
    src = inspect.getsource(soak.main)
    assert "--priority-fraction" in src and "--protected-fraction" not in src


def test_patterns_are_varied_and_formatted():
    pats = {p.format(s="640x360", r=25) for p in soak.PATTERNS}
    assert len(pats) == len(soak.PATTERNS) >= 4 and all("640x360" in p for p in pats)
