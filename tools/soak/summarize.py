#!/usr/bin/env python3
"""Turn soak result JSON files into a Markdown table.

  python3 summarize.py results/*.json

Reads both result formats: the current one (`priority`, `window`,
`whole_run`) and the pre-pivot one (`protected`, `window_dropped`, `totals`).
"""
import json
import sys


def f(v, nd=1):
    return "–" if v is None else f"{v:.{nd}f}"


def _get(d, *keys):
    """d[k1][k2]..., or None if any level is missing or None (e.g. an empty camera group)."""
    for k in keys:
        if not isinstance(d, dict) or d.get(k) is None:
            return None
        d = d[k]
    return d


def _window(s: dict) -> tuple:
    w = s.get("window")
    if w:
        return w.get("frames_dropped"), w.get("decode_errors"), w.get("reconnects")
    return s.get("window_dropped"), s.get("window_decode_errors"), s.get("window_reconnects")


def row(r: dict) -> str:
    a, s = r["params"], r["summary"]
    w, pub, mtx = s["vision-worker"], s["ffmpeg publishers"], s["mediamtx"]
    pr = s.get("priority") or s.get("protected") or {}
    no = s.get("normal") or {}
    dropped, dec, rec = _window(s)
    return (f"| {a['detector']} | {a['resolution']} | {a['cameras']} "
            f"| {f(_get(w, 'cpu_pct', 'mean'))} ({f(_get(w, 'cpu_pct', 'max'))}) | {f(w.get('rss_mb_max'), 0)} "
            f"| {f(_get(pub, 'cpu_pct', 'mean'))} | {f(_get(mtx, 'cpu_pct', 'mean'))} "
            f"| {f(_get(s, 'host_cpu_pct', 'mean'))} ({f(r.get('baseline_host_cpu_pct'))}) "
            f"| {f(_get(s, 'decoded_fps', 'mean'))} ({f(_get(s, 'decoded_fps', 'min_camera'))}) "
            f"| {f(_get(pr, 'analyzed_fps', 'mean'), 2)} / {f(_get(pr, 'analyzed_fps', 'min_camera'), 2)} "
            f"/ {f(pr.get('worst_interval_analyzed_fps'), 1)} "
            f"| {f(_get(no, 'analyzed_fps', 'mean'), 2)} / {f(_get(no, 'analyzed_fps', 'min_camera'), 2)} "
            f"| {dropped} | {dec} | {rec} |")


def main(paths):
    rows = []
    for p in paths:
        with open(p) as fh:
            r = json.load(fh)
        a = r["params"]
        rows.append((a["detector"], a["resolution"], a["cameras"], r))
    rows.sort(key=lambda x: (x[0], x[1] != "640x360", x[2]))
    print("| Detector | Res | N | vision-worker CPU % mean (max) | worker RSS MB | ffmpeg pubs CPU % | MediaMTX CPU % "
          "| Host CPU % mean (baseline) | Decoded fps/cam (min) | Priority analyzed fps mean / min cam / worst interval "
          "| Normal analyzed fps mean / min cam | Dropped (window) | Decode err (window) | Reconnects (window) |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for _, _, _, r in rows:
        print(row(r))
        if r.get("fault"):
            print(f"|  | fault on {r['fault']['camera']}: RECONNECTING after {r['fault'].get('to_reconnecting_s')} s, "
                  f"STREAMING {r['fault'].get('recovery_after_restart_s')} s after restart |||||||||||||")


if __name__ == "__main__":
    main(sys.argv[1:])
