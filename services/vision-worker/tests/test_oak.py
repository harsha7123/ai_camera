"""OAK PoE cameras (on-camera person detection) without hardware.

A fake OAK session plays what the camera would send: real H.264 access units
(encoded in memory by PyAV, Annex-B like the OAK's encoder), 160x90 grey
thumbnails and detections paired by sequence number. The DepthAI pipeline
itself is built and checked offline when the "oak" extra is installed."""

import hashlib
import io
import json
import time
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import pytest

from zeoatap_vision.config import CameraConfig, OakOptions, WorkerConfig
from zeoatap_vision.observation import NoDetector
from zeoatap_vision.oak import (PIPELINE_ID, BlobMismatch, DepthAISession, OakCameraWorker, is_keyframe,
                                person_boxes, verify_blob)
from zeoatap_vision.timing import Backoff
from zeoatap_vision.worker import VisionWorker

FPS = 15
W, H = 64, 48
SCHEMA = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "observation.schema.json"


def h264_units(n, gop=FPS):
    cc = av.CodecContext.create("libx264", "w")
    cc.width, cc.height, cc.pix_fmt = W, H, "yuv420p"
    cc.time_base, cc.framerate = Fraction(1, FPS), Fraction(FPS)
    cc.options = {"g": str(gop), "bf": "0"}
    out = []
    for i in range(n):
        f = av.VideoFrame.from_ndarray(np.full((H, W, 3), (i * 7) % 255, np.uint8), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        out += [bytes(p) for p in cc.encode(f)]
    out += [bytes(p) for p in cc.encode()]
    return out


def thumb(i):
    rng = np.random.default_rng(i)  # textured and changing: never black, obstructed or frozen
    return rng.integers(0, 255, (90, 160), dtype=np.uint8)


def opts(tmp_path=None, **kw):
    d = dict(blob=str(tmp_path / "m.blob") if tmp_path else "m.blob", blob_sha256="0" * 64,
             video_size=(W, H), fps=FPS)
    d.update(kw)
    return OakOptions(**d)


def oak_cam(tmp_path=None, **kw):
    return CameraConfig(id="cam-counter", url="oak://192.168.50.21", kind="oak", priority=True, oak=opts(tmp_path, **kw))


class FakeSession:
    def __init__(self, batches):
        self.batches = list(batches)
        self.closed = False

    def poll(self, timeout):
        """Deliver each frame's messages when the camera would: in real time."""
        if self.batches:
            due = self.batches[0][0][1]
            wait = due - time.monotonic()
            if wait > timeout:
                time.sleep(timeout)
                return []
            if wait > 0:
                time.sleep(wait)
            return self.batches.pop(0)
        time.sleep(min(timeout, 0.02))
        return []

    def close(self):
        self.closed = True


class FakeSource:
    runtime = "fake-depthai"

    def __init__(self, make):
        self.make = make
        self.sessions = []

    def connect(self, cam):
        # Only the first connection plays the scene unless make says otherwise;
        # later ones are quiet (the worker reconnects after read_timeout).
        s = FakeSession(self.make(len(self.sessions)))
        self.sessions.append(s)
        return s


def scene(n=45, dets_every=1, with_dets=True, skip_first=0):
    """n frames from 'now' on the monotonic clock: video, thumbnail and (every
    dets_every frames) detections of one person walking right, plus a
    non-person label and a broken box that must be dropped."""
    t0 = time.monotonic()
    units = h264_units(n)
    batches = []
    for i in range(skip_first, n):
        ts = t0 + i / FPS
        b = [("h264", ts, i, units[i]), ("thumb", ts, i, thumb(i))]
        if with_dets and i % dets_every == 0:
            x = 0.1 + 0.01 * i
            b.append(("dets", ts, i, [(1, 0.9, x, 0.2, x + 0.2, 0.9),
                                      (2, 0.95, 0.5, 0.5, 0.6, 0.6),          # not a person
                                      (1, float("nan"), 0.1, 0.1, 0.2, 0.2),  # broken
                                      (1, 0.3, 0.7, 0.2, 0.8, 0.9)]))        # below confidence
        batches.append(b)
    return batches


class Collect:
    def __init__(self):
        self.obs = []
        self.written = 0

    def emit(self, o):
        self.obs.append(o)
        self.written += 1


def run_worker(source, cam, seconds=4.0, until=None):
    sink = Collect()
    vw = VisionWorker(WorkerConfig([cam]), NoDetector(), sink, oak_source=source)
    c = vw.cameras[cam.id]
    c.backoff = Backoff(initial=0.05, maximum=0.1)
    c._read_timeout = 0.4
    vw.start()
    end = time.monotonic() + seconds
    while time.monotonic() < end and not (until and until(vw, sink)):
        time.sleep(0.05)
    vw.stop()
    return vw, sink


def test_oak_detections_become_valid_observations():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(SCHEMA.read_text())
    vw, sink = run_worker(FakeSource(lambda i: scene() if i == 0 else []), oak_cam(), until=lambda vw, s: len(s.obs) >= 40)
    assert len(sink.obs) >= 30, "priority OAK camera samples at 15 fps"
    for o in sink.obs:
        jsonschema.validate(o, schema)
        assert o["source"] == PIPELINE_ID and o["frame_size"] == [W, H]
        assert o["model_versions"]["detector"].startswith("person-detection-retail-0013@")
        assert o["model_versions"]["on_camera"] == "true" and o["model_versions"]["runtime"] == "fake-depthai"
    assert all(o["ai_available"] for o in sink.obs)
    tracked = [o for o in sink.obs if o["tracks"]]
    assert tracked, "confirmed tracks appear after the tracker's second hit"
    assert all(len(o["tracks"]) == 1 for o in tracked), "other labels, NaN and low scores are dropped"
    assert len({o["tracks"][0]["id"] for o in tracked}) == 1, "one walking person keeps one anonymous id"
    xs = [o["tracks"][0]["box"][0] for o in tracked]
    assert xs == sorted(xs), "boxes follow the person"
    st = vw.status()
    assert st["ai_available"] is True and st["onboard_cameras"] == ["cam-counter"]
    cam = next(c for c in st["cameras"] if c["camera_id"] == "cam-counter")
    assert cam["kind"] == "oak" and cam["device"] == "192.168.50.21" and cam["nn_frames_total"] >= 30


def test_oak_video_makes_a_playable_evidence_clip(tmp_path):
    vw, _ = run_worker(FakeSource(lambda i: scene(60) if i == 0 else []), oak_cam(),
                       until=lambda vw, s: len(vw.cameras["cam-counter"].ring) >= 60)
    cam = vw.cameras["cam-counter"]
    oldest, newest, _, n = cam.ring.span()
    assert n == 60 and newest - oldest == pytest.approx(59 / FPS, abs=0.2)
    fut = cam.request_clip(oldest, newest, tmp_path / "clip.mp4", wait_s=0)
    cam._finish_clip_jobs(force=True)
    path, sha, partial = fut.result(timeout=5)
    assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == sha
    with av.open(str(path)) as c:
        frames = sum(1 for _ in c.decode(video=0))
        assert frames == 60 and c.streams.video[0].codec_context.width == W
    assert not partial


def test_stream_joined_mid_gop_starts_at_the_first_keyframe():
    vw, _ = run_worker(FakeSource(lambda i: scene(45, skip_first=5) if i == 0 else []), oak_cam(),
                       until=lambda vw, s: len(s.obs) >= 30)
    cam = vw.cameras["cam-counter"]
    assert cam.h264_before_keyframe_total == 10  # frames 5..14 precede the keyframe at 15
    first = cam.ring.snapshot(0, 1e18)[0]
    assert first.keyframe and is_keyframe(bytes(first.packet))


def test_silent_network_reports_ai_unavailable():
    _, sink = run_worker(FakeSource(lambda i: scene(45, with_dets=False) if i == 0 else []), oak_cam(), seconds=3.5,
                         until=lambda vw, s: len(s.obs) >= 10)
    assert sink.obs, "thumbnails still flow, so camera health is still reported"
    assert all(not o["ai_available"] and o["tracks"] == [] for o in sink.obs)


def test_network_slower_than_camera_does_not_flap():
    _, sink = run_worker(FakeSource(lambda i: scene(60, dets_every=2) if i == 0 else []), oak_cam(),
                         until=lambda vw, s: len(s.obs) >= 25)
    assert len(sink.obs) >= 20
    assert all(o["ai_available"] for o in sink.obs), "skipped frames are dropped, never sent as AI_UNAVAILABLE"


def test_reconnects_when_the_camera_goes_quiet():
    src = FakeSource(lambda i: scene(20) if i == 0 else scene(20))
    vw, _ = run_worker(src, oak_cam(), seconds=4, until=lambda vw, s: len(src.sessions) >= 2)
    assert len(src.sessions) >= 2 and src.sessions[0].closed
    assert vw.cameras["cam-counter"].stats.reconnects_total >= 1


def test_person_boxes_filters_and_scales():
    o = opts(video_size=(1920, 1080), person_labels=(1, 15), confidence=0.5)
    boxes, scores = person_boxes([(1, 0.8, -0.1, 0.2, 0.5, 1.2), (15, 0.6, 0.5, 0.5, 0.5, 0.9),
                                  (15, 0.7, 0.6, 0.1, 0.7, 0.4), (3, 0.99, 0, 0, 1, 1)], o)
    assert boxes.tolist() == [[0.0, 216.0, 960.0, 1080.0], [1152.0, 108.0, pytest.approx(1344.0), 432.0]]
    assert scores.tolist() == pytest.approx([0.8, 0.7])


def test_blob_is_pinned_by_sha256(tmp_path):
    p = tmp_path / "m.blob"
    p.write_bytes(b"model")
    good = hashlib.sha256(b"model").hexdigest()
    assert verify_blob(opts(tmp_path, blob_sha256=good)) == p
    with pytest.raises(BlobMismatch):
        verify_blob(opts(tmp_path, blob_sha256="a" * 64))
    with pytest.raises(FileNotFoundError):
        verify_blob(opts(blob=str(tmp_path / "missing.blob")))


def test_oak_config_validation(tmp_path):
    with pytest.raises(ValueError, match="oak section|'oak' section"):
        CameraConfig(id="c", url="oak://1.2.3.4", kind="oak")
    with pytest.raises(ValueError, match="oak://"):
        CameraConfig(id="c", url="rtsp://1.2.3.4/x", kind="oak", oak=opts())
    with pytest.raises(ValueError, match="need kind 'oak'"):
        CameraConfig(id="c", url="rtsp://1.2.3.4/x", oak=opts())
    with pytest.raises(ValueError, match="sha256"):
        opts(blob_sha256="not-a-hash")
    with pytest.raises(ValueError):
        CameraConfig(id="c", url="rtsp://h/x", kind="usb")
    cfg = tmp_path / "cams.json"
    cfg.write_text(json.dumps({"cameras": [
        {"id": "cam-back", "url": "oak://14442C10D13EABCE00", "kind": "oak",
         "oak": {"blob": "m.blob", "blob_sha256": "b" * 64, "nn_size": [544, 320], "person_labels": [1]}},
        {"id": "cam-dining", "url": "rtsp://192.168.50.13:554/h264Preview_01_main"}]}))
    wc = WorkerConfig.load(cfg)
    assert wc.cameras[0].device == "14442C10D13EABCE00" and wc.cameras[0].oak.nn_size == (544, 320)
    assert wc.cameras[1].kind == "rtsp"


def test_depthai_session_converts_messages():
    class Msg:
        def __init__(self, **kw):
            self.__dict__.update(kw)

        def getTimestamp(self):
            import datetime
            return datetime.timedelta(seconds=12.5)

        def getSequenceNum(self):
            return 7

        def getData(self):
            return self.data

        def getHeight(self):
            return 90

        def getWidth(self):
            return 160

    det = Msg(label=1, confidence=0.9, xmin=0.1, ymin=0.2, xmax=0.3, ymax=0.8)
    assert DepthAISession._convert("h264", Msg(data=np.frombuffer(b"\x00\x00\x01\x65", np.uint8))) == ("h264", 12.5, 7, b"\x00\x00\x01\x65")
    k, ts, seq, g = DepthAISession._convert("thumb", Msg(data=np.zeros(160 * 90, np.uint8)))
    assert (k, ts, seq, g.shape) == ("thumb", 12.5, 7, (90, 160))
    assert DepthAISession._convert("dets", Msg(detections=[det]))[3] == [(1, 0.9, 0.1, 0.2, 0.3, 0.8)]


def test_depthai_pipeline_builds_offline():
    dai = pytest.importorskip("depthai")
    from zeoatap_vision.oak import build_pipeline
    o = OakOptions(blob="m.blob", blob_sha256="0" * 64)
    pl = build_pipeline(dai, o, None).serializeToJson()["pipeline"]
    nodes = {n[0]: n[1]["name"] for n in pl["nodes"]}
    assert sorted(nodes.values()) == sorted(["ColorCamera", "VideoEncoder", "DetectionNetwork", "ImageManip",
                                             "XLinkOut", "XLinkOut", "XLinkOut"])
    names = {n[0]: n[1]["properties"].get("streamName") for n in pl["nodes"] if n[1]["name"] == "XLinkOut"}
    links = {(nodes[c["node1Id"]], c["node1Output"], names.get(c["node2Id"]) or nodes[c["node2Id"]], c["node2Input"])
             for c in pl["connections"]}
    assert ("VideoEncoder", "bitstream", "h264", "in") in links
    assert ("DetectionNetwork", "out", "dets", "in") in links
    assert ("ImageManip", "out", "thumb", "in") in links
    assert ("ColorCamera", "preview", "DetectionNetwork", "in") in links
    assert ("ColorCamera", "preview", "ImageManip", "inputImage") in links
    assert ("ColorCamera", "video", "VideoEncoder", "in") in links


def test_hybrid_example_config_is_valid_once_the_hash_is_filled_in(tmp_path):
    raw = (Path(__file__).resolve().parents[1] / "cameras.hybrid-oak.example.json").read_text()
    assert "REPLACE_WITH_THE_SHA256" in raw, "the example must not ship a made-up hash"
    filled = tmp_path / "cams.json"
    filled.write_text(raw.replace("REPLACE_WITH_THE_SHA256_PRINTED_BY_scripts/fetch_oak_model.py_______", "c" * 64))
    wc = WorkerConfig.load(filled)
    kinds = {c.id: c.kind for c in wc.cameras}
    assert kinds == {"cam-entrance": "rtsp", "cam-counter": "oak", "cam-dining": "rtsp", "cam-kitchen": "rtsp",
                     "cam-back": "oak", "cam-office": "rtsp"}
    assert wc.cameras[1].priority and wc.cameras[1].device == "192.168.50.12"
