import json
import random
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from zeoatap_vision.config import CameraConfig, WorkerConfig, redact
from zeoatap_vision.observation import MockDetector, NoDetector, build_observation
from zeoatap_vision.quality import QualityMonitor, QualityResult
from zeoatap_vision.ringbuffer import PacketRingBuffer
from zeoatap_vision.timing import Backoff, FrameSampler

SCHEMA = json.loads((Path(__file__).parents[3] / "packages/contracts/observation.schema.json").read_text())


class FakePacket:
    def __init__(self, size, key):
        self.size, self.is_keyframe = size, key


# ---- ring buffer --------------------------------------------------------
def test_ring_evicts_by_age_and_bytes():
    rb = PacketRingBuffer(max_seconds=10, max_bytes=1000)
    for i in range(30):
        rb.append(FakePacket(10, i % 5 == 0), float(i))
    assert rb.oldest_ts >= 19 and rb.newest_ts == 29
    rb2 = PacketRingBuffer(max_seconds=100, max_bytes=50)
    for i in range(20):
        rb2.append(FakePacket(10, True), float(i))
    assert rb2.bytes <= 50 and len(rb2) == 5


def test_snapshot_starts_at_keyframe_before_start():
    rb = PacketRingBuffer(60, 10**9)
    for i in range(20):
        rb.append(FakePacket(1, i % 5 == 0), float(i))  # keyframes at 0,5,10,15
    snap = rb.snapshot(12.0, 17.0)
    assert snap[0].wall_ts == 10.0 and snap[0].keyframe
    assert snap[-1].wall_ts == 17.0


def test_span_is_consistent_while_another_thread_clears():
    import threading
    rb = PacketRingBuffer(60, 10**9)
    stop = threading.Event()

    def churn():
        i = 0
        while not stop.is_set():
            rb.append(FakePacket(1, True), float(i))
            i += 1
            if i % 7 == 0:
                rb.clear()

    t = threading.Thread(target=churn)
    t.start()
    try:
        for _ in range(20000):
            oldest, newest, nbytes, n = rb.span()
            assert (oldest is None) == (newest is None) == (n == 0)
            if n:
                assert newest >= oldest
    finally:
        stop.set()
        t.join()


def test_snapshot_without_keyframe_is_empty():
    rb = PacketRingBuffer(60, 10**9)
    for i in range(5):
        rb.append(FakePacket(1, False), float(i))
    assert rb.snapshot(1, 3) == []


# ---- quality ------------------------------------------------------------
def noisy(seed, mean=120):
    return np.random.default_rng(seed).normal(mean, 30, (90, 160)).clip(0, 255).astype(np.uint8)


def run(mon, frames, fps=5.0, t0=0.0):
    res = None
    for i, f in enumerate(frames):
        res = mon.update(f, t0 + i / fps)
    return res


def test_normal_video_is_not_degraded():
    assert run(QualityMonitor(), [noisy(i) for i in range(50)]) == QualityResult(False)


def test_black_after_three_seconds_then_recovers():
    mon = QualityMonitor()
    black = np.zeros((90, 160), np.uint8)
    assert not run(mon, [black] * 10).degraded  # 1.8 s: not yet
    r = run(mon, [black] * 20, t0=2.0)
    assert r.degraded and r.reason == "black"
    # recovers only after recover_after_s of good frames
    assert run(mon, [noisy(i) for i in range(10)], t0=10.0).degraded
    assert not run(mon, [noisy(i) for i in range(40)], t0=20.0).degraded


def test_covered_lens_is_obstructed():
    grey = np.full((90, 160), 90, np.uint8)
    r = run(QualityMonitor(), [grey] * 40)
    assert r.degraded and r.reason == "obstructed"


def test_identical_frames_are_frozen_only_after_long_window():
    f = noisy(1)
    mon = QualityMonitor()
    assert not run(mon, [f] * 100).degraded  # 20 s
    r = run(mon, [f] * 60, t0=20.0)  # past 30 s
    assert r.degraded and r.reason == "frozen"


def test_frozen_tolerates_rounding_only():
    base = noisy(7)
    rng = np.random.default_rng(0)
    frames = [np.clip(base.astype(int) + rng.integers(0, 2, base.shape), 0, 255).astype(np.uint8)
              for _ in range(200)]  # the same picture, off by up to 1 grey level (rounding)
    mon = QualityMonitor()
    assert not run(mon, frames[:100]).degraded  # 20 s
    r = run(mon, frames[100:], t0=20.0)
    assert r.degraded and r.reason == "frozen"


@pytest.mark.parametrize("base", [
    np.random.default_rng(3).normal(120, 30, (90, 160)),  # textured still scene
    np.full((90, 160), 40.0),  # dark, uniform still scene (an empty room at night)
])
def test_still_live_scene_with_sensor_noise_is_not_frozen(base):
    rng = np.random.default_rng(1)
    frames = [np.clip(base + rng.normal(0, 2, base.shape), 0, 255).astype(np.uint8) for _ in range(300)]  # 60 s
    mon = QualityMonitor()
    for i, f in enumerate(frames):
        r = mon.update(f, i / 5.0)
        assert r.reason != "frozen"
    if base.std() > 10:
        assert not r.degraded


def test_clock_overlay_defeats_frozen_detection():
    """Documented trade-off: a stalled sensor with a live OSD clock is not
    detected as frozen (RTP/timestamp-level stall detection is the roadmap fix)."""
    base = noisy(5)
    frames = []
    for i in range(300):
        f = base.copy()
        f[2:7, 140:150] = (i * 37) % 255  # changing seconds digits
        frames.append(f)
    assert not run(QualityMonitor(), frames).degraded


# ---- timing -------------------------------------------------------------
def test_sampler_hits_target_rate_from_30fps_input():
    s = FrameSampler(5)
    picked = sum(s.should_sample(i / 30) for i in range(300))  # 10 s
    assert 49 <= picked <= 51


def test_sampler_burst_raises_rate_temporarily():
    s = FrameSampler(5)
    s.burst(15, until=5.0)
    first = sum(s.should_sample(i / 30) for i in range(150))
    second = sum(s.should_sample(5 + i / 30) for i in range(150))
    assert 70 <= first <= 76 and 24 <= second <= 26


def test_sampler_does_not_catch_up_after_gap():
    s = FrameSampler(5)
    assert s.should_sample(0.0)
    assert s.should_sample(100.0)
    assert not s.should_sample(100.05)


def test_backoff_grows_caps_and_resets():
    b = Backoff(1, 30, rng=random.Random(0))
    d = [b.next_delay() for _ in range(8)]
    assert d[0] <= 1 and all(x <= 30 for x in d) and d[-1] >= 15
    b.reset()
    assert b.next_delay() <= 1


# ---- config & secrets ---------------------------------------------------
def test_credentials_come_from_env_and_are_redacted(monkeypatch, tmp_path):
    monkeypatch.setenv("CAM1_CREDS", "admin:s3cr@t")
    cam = CameraConfig(id="cam1", url="rtsp://10.0.0.5:554/stream1", credentials_env="CAM1_CREDS")
    url = cam.resolved_url()
    assert url == "rtsp://admin:s3cr%40t@10.0.0.5:554/stream1"
    assert "s3cr" not in redact(f"failed to open {url}")


@pytest.mark.parametrize("url,want", [
    ("rtsp://[fe80::1]:554/x", "rtsp://u:p%3Aw@[fe80::1]:554/x"),
    ("rtsp://[2001:db8::7]/live?ch=1", "rtsp://u:p%3Aw@[2001:db8::7]/live?ch=1"),
    ("rtsp://cam.local/x", "rtsp://u:p%3Aw@cam.local/x"),
])
def test_credentials_keep_ipv6_brackets(monkeypatch, url, want):
    monkeypatch.setenv("C", "u:p:w")
    assert CameraConfig(id="c", url=url, credentials_env="C").resolved_url() == want


def test_config_rejects_inline_credentials(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"cameras": [{"id": "c", "url": "rtsp://u:p@h/s"}]}))
    with pytest.raises(ValueError, match="credentials_env"):
        WorkerConfig.load(p)


def test_priority_camera_never_below_15fps():
    assert CameraConfig(id="c", url="x", priority=True, base_fps=5).target_fps == 15
    assert CameraConfig(id="c", url="x").target_fps == 5


def test_example_config_matches_the_example_site(tmp_path):
    root = Path(__file__).parents[1]
    cfg = WorkerConfig.load(root / "cameras.example.json")
    site = json.loads((root.parents[1] / "services/core/site.example.json").read_text())
    assert [c.id for c in cfg.cameras] == [c["id"] for c in site["cameras"]]
    for c, s in zip(cfg.cameras, site["cameras"]):
        assert c.priority == s.get("priority", False)
    assert next(c for c in cfg.cameras if c.id == "cam-counter").target_fps == 15


def test_legacy_protected_key_maps_to_priority(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"cameras": [{"id": "c", "url": "rtsp://h/s", "protected": True}]}))
    assert WorkerConfig.load(p).cameras[0].priority is True
    p.write_text(json.dumps({"cameras": [{"id": "c", "url": "rtsp://h/s", "protected": True, "priority": True}]}))
    with pytest.raises(ValueError):
        WorkerConfig.load(p)


# ---- contract -----------------------------------------------------------
@pytest.mark.parametrize("det", [NoDetector(), MockDetector()])
def test_observation_matches_contract(det):
    obs = build_observation("cam1", 1793448000.123, QualityResult(True, "black"), det, [], frame_size=(1280, 720))
    jsonschema.validate(obs, SCHEMA)
    assert obs["capture_ts"] == "2026-10-31T12:00:00.123Z"
    assert obs["ai_available"] is det.available
    assert obs["frame_size"] == [1280, 720]
    assert "frame_size" not in build_observation("cam1", 0.0, QualityResult(False), det, [])
    bad = dict(obs, frame_size=[0, 720])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, SCHEMA)
    with pytest.raises(jsonschema.ValidationError):  # schema v2: no extra fields (e.g. v1's "held")
        jsonschema.validate(dict(obs, tracks=[{"id": "a", "role": "person", "score": 0.5,
                                               "box": [0, 0, 1, 1], "held": False}]), SCHEMA)
