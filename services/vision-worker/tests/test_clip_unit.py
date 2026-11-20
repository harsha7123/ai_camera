"""Evidence clips without a camera: real H.264 packets encoded in memory by
PyAV, fed into the ring buffer as a camera would. Covers clip-writing failure
safety, partial marking (eviction, gaps, end not reached), clips across a
reconnect, and the clip-path confinement of POST /v1/clips."""

import io
import os
from pathlib import Path

import av
import numpy as np
import pytest

from zeoatap_vision.camera import CameraWorker, ClipTemplate, NoVideoError
from zeoatap_vision.clip import write_clip
from zeoatap_vision.config import CameraConfig
from zeoatap_vision.ringbuffer import PacketRingBuffer
from zeoatap_vision.worker import ClipError, validate_clip_request

FPS = 10


def encode(n=40, w=64, h=48, gop=10):
    """n frames of H.264 at 10 fps, demuxed back as a camera stream would be.
    Returns (template, packets); the input container is already closed."""
    buf = io.BytesIO()
    with av.open(buf, "w", format="mp4") as o:
        s = o.add_stream("libx264", rate=FPS)
        s.width, s.height, s.pix_fmt = w, h, "yuv420p"
        s.options = {"g": str(gop), "bf": "0"}
        for i in range(n):
            f = av.VideoFrame.from_ndarray(np.full((h, w, 3), (i * 5) % 255, np.uint8), format="rgb24")
            f.pts = i
            for p in s.encode(f):
                o.mux(p)
        for p in s.encode():
            o.mux(p)
    buf.seek(0)
    with av.open(buf) as c:
        v = c.streams.video[0]
        tmpl = ClipTemplate(v)
        pkts = [p for p in c.demux(v) if p.size]
    return tmpl, pkts


def stamps(pkts):
    return [(p.pts, p.dts, p.time_base) for p in pkts]


def frames_in(path):
    with av.open(str(path)) as c:
        return len(list(c.decode(video=0)))


def camera_with(*segments):
    """CameraWorker whose ring holds the given (t0, template, packets)
    segments, one connection generation each."""
    cw = CameraWorker(CameraConfig(id="cam1", url="rtsp://127.0.0.1:1/x", ring_seconds=1e6))
    for gen, (t0, tmpl, pkts) in enumerate(segments, start=1):
        cw._templates[gen] = tmpl
        for i, p in enumerate(pkts):
            cw.ring.append(p, t0 + i / FPS, gen)
    cw._clock = lambda: 1e12  # every job is past its deadline when finished
    return cw


def clip(cw, start, end, path):
    fut = cw.request_clip(start, end, path, wait_s=0)
    cw._finish_clip_jobs()
    return fut.result(timeout=1)


def test_failed_mux_never_corrupts_ring_packets(tmp_path):
    tmpl, pkts = encode()
    before = stamps(pkts)
    rb = PacketRingBuffer(1e6, 10**9)
    for i, p in enumerate(pkts):
        rb.append(p, 100 + i / FPS)
    snap = rb.snapshot(100, 200)
    sha1 = write_clip(snap, tmpl.stream, tmp_path / "a.mp4")
    assert stamps(pkts) == before  # muxing rescales in place; the ring copy must not change
    # A packet repeated out of order makes the MP4 muxer fail half-way.
    with pytest.raises(Exception):
        write_clip(snap[:15] + snap[5:6] + snap[15:], tmpl.stream, tmp_path / "b.mp4")
    assert not (tmp_path / "b.mp4").exists() and not (tmp_path / "b.mp4.part").exists()
    assert stamps(pkts) == before
    sha2 = write_clip(snap, tmpl.stream, tmp_path / "c.mp4")
    assert sha2 == sha1 and frames_in(tmp_path / "c.mp4") == len(pkts)


def test_clip_fully_covered_is_not_partial(tmp_path):
    tmpl, pkts = encode()
    cw = camera_with((100.0, tmpl, pkts))  # 100.0 .. 103.9
    path, sha, partial = clip(cw, 101.0, 103.5, tmp_path / "ok.mp4")
    assert partial is False and len(sha) == 64 and frames_in(path) > 20


def test_clip_is_partial_when_ring_no_longer_reaches_start(tmp_path):
    tmpl, pkts = encode()
    cw = camera_with((100.0, tmpl, pkts))
    _, _, partial = clip(cw, 95.0, 103.5, tmp_path / "evicted.mp4")  # 5 s before the oldest packet
    assert partial is True
    # within the tolerance (the first packet is at the start): not partial
    _, _, partial = clip(cw, 99.8, 103.5, tmp_path / "edge.mp4")
    assert partial is False


def test_clip_is_partial_when_end_is_not_reached(tmp_path):
    tmpl, pkts = encode()
    cw = camera_with((100.0, tmpl, pkts))
    _, _, partial = clip(cw, 101.0, 110.0, tmp_path / "short.mp4")
    assert partial is True


def test_clip_spans_a_reconnect_and_reports_the_gap(tmp_path):
    t1, p1 = encode(40)
    t2, p2 = encode(40)  # timestamps restart at 0, as after a new RTSP session
    cw = camera_with((100.0, t1, p1), (110.0, t2, p2))  # 6 s outage between 103.9 and 110
    path, _, partial = clip(cw, 100.0, 113.0, tmp_path / "gap.mp4")
    assert partial is True  # the outage is a hole in the evidence
    with av.open(str(path)) as c:
        times = [float(f.time) for f in c.decode(video=0)]
    assert len(times) == 71  # 40 before the outage + 31 after it (110.0 .. 113.0), nothing dropped
    assert times == sorted(times)
    gap = max(b - a for a, b in zip(times, times[1:]))
    assert 5.5 < gap < 6.5  # placed by wall clock: the outage shows as a gap, not spliced video
    # the pre-outage packets survive the reconnect (the ring is not cleared)
    path, _, partial = clip(cw, 100.5, 103.5, tmp_path / "before.mp4")
    assert partial is False and frames_in(path) > 20


def test_reconnect_with_different_resolution_keeps_one_configuration(tmp_path):
    t1, p1 = encode(40, 64, 48)
    t2, p2 = encode(20, 96, 64)
    cw = camera_with((100.0, t1, p1), (104.0, t2, p2))
    path, _, partial = clip(cw, 100.0, 105.9, tmp_path / "mixed.mp4")
    assert partial is True
    with av.open(str(path)) as c:
        v = c.streams.video[0]
        assert (v.width, v.height) == (64, 48)
        assert len(list(c.decode(v))) == 40


def test_no_video_for_window(tmp_path):
    tmpl, pkts = encode()
    cw = camera_with((100.0, tmpl, pkts))
    fut = cw.request_clip(10.0, 20.0, tmp_path / "none.mp4", wait_s=0)
    cw._finish_clip_jobs()
    with pytest.raises(NoVideoError):
        fut.result(timeout=1)


def test_status_never_fails_while_ring_is_cleared():
    import threading

    tmpl, pkts = encode(10)
    cw = camera_with((100.0, tmpl, pkts))
    stop = threading.Event()

    def churn():
        while not stop.is_set():
            cw.ring.clear()
            for i, p in enumerate(pkts):
                cw.ring.append(p, 100 + i / FPS)

    t = threading.Thread(target=churn)
    t.start()
    try:
        for _ in range(5000):
            assert cw.status()["ring_seconds"] >= 0
    finally:
        stop.set()
        t.join()


# ---- clip path confinement -------------------------------------------------
def req(path):
    return {"camera_id": "cam1", "start": 100.0, "end": 110.0, "path": str(path)}


def test_clip_paths_stay_inside_the_spool(tmp_path):
    spool = tmp_path / "spool"
    spool.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    ok = validate_clip_request(req(spool / "sub" / "a.mp4"), spool, 200.0)[3]
    assert ok == spool.resolve() / "sub" / "a.mp4"
    for bad in (outside / "a.mp4", Path("/etc/cron.d/x.mp4"), spool / ".." / "elsewhere" / "a.mp4"):
        with pytest.raises(ClipError) as e:
            validate_clip_request(req(bad), spool, 200.0)
        assert e.value.code == 400
    (spool / "link").symlink_to(outside, target_is_directory=True)  # a symlinked directory escapes
    with pytest.raises(ClipError, match="outside"):
        validate_clip_request(req(spool / "link" / "a.mp4"), spool, 200.0)
    os.symlink(outside / "victim.mp4", spool / "evil.mp4")  # the file itself is a symlink
    with pytest.raises(ClipError, match="symlink"):
        validate_clip_request(req(spool / "evil.mp4"), spool, 200.0)
    # a symlinked spool root is fine: both sides are resolved
    (tmp_path / "spool-link").symlink_to(spool, target_is_directory=True)
    assert validate_clip_request(req(spool / "b.mp4"), tmp_path / "spool-link", 200.0)[3].parent == spool.resolve()
