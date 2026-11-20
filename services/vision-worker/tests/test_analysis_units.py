"""Unit tests for the detection pipeline pieces that need no model files:
tracker, pose metrics, box normalization, NaN handling, the analysis-loop
guard, and the pipeline/worker contract (schema-valid observations with role
"person" and frame_size, degraded frames skip detection, failed inference
reports ai_available=false)."""

import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import jsonschema
import numpy as np
import pytest

from zeoatap_vision.config import CameraConfig, WorkerConfig
from zeoatap_vision.models import MODELS, ModelMissing, resolve
from zeoatap_vision.observation import JsonlSink, MockDetector
from zeoatap_vision.pipeline import PersonPipeline, normalize_box, pose_metrics
from zeoatap_vision.tracker import ByteTracker, greedy_match, iou_matrix
from zeoatap_vision.worker import LOOP_FAIL_LIMIT, VisionWorker

SCHEMA = json.loads((Path(__file__).parents[3] / "packages/contracts/observation.schema.json").read_text())


# ---- tracker -------------------------------------------------------------
def test_iou_and_greedy_match():
    a = np.array([[0, 0, 10, 10], [20, 20, 30, 30]], np.float32)
    b = np.array([[21, 21, 31, 31], [0, 0, 10, 10]], np.float32)
    iou = iou_matrix(a, b)
    assert iou[0, 1] == pytest.approx(1.0) and iou[0, 0] == 0
    m, ur, uc = greedy_match(iou, 0.3)
    assert sorted(m) == [(0, 1), (1, 0)] and not ur and not uc


def test_tracker_keeps_ids_for_moving_people_and_confirms_after_two_hits():
    tr = ByteTracker()
    a, b = np.array([10, 10, 50, 110.0]), np.array([200, 20, 240, 120.0])
    out0 = tr.update(np.stack([a, b]), np.array([0.9, 0.8]), 0.0)
    assert out0 == []  # not confirmed yet (min_hits=2)
    ids = None
    for i in range(1, 15):
        d = np.array([3.0 * i, 0, 3.0 * i, 0])
        out = tr.update(np.stack([a + d, b - d]), np.array([0.9, 0.8]), i * 0.2)
        assert len(out) == 2
        cur = {t.det_index: t.id for t in out}
        ids = ids or cur
        assert cur == ids  # same person keeps the same id
    assert len(set(ids.values())) == 2
    assert all(t.age_s(14 * 0.2) == pytest.approx(14 * 0.2) for t in tr.tracks)


def test_tracker_low_score_detection_keeps_track_but_does_not_start_one():
    tr = ByteTracker()
    box = np.array([[100, 100, 150, 220.0]])
    for i in range(3):
        tr.update(box, np.array([0.9]), i * 0.2)
    tid = tr.tracks[0].id
    out = tr.update(box + 2, np.array([0.3]), 0.6)  # occluded: score drops (ByteTrack 2nd stage)
    assert [t.id for t in out] == [tid]
    tr2 = ByteTracker()
    tr2.update(box, np.array([0.3]), 0.0)
    assert tr2.tracks == []


def test_tracker_drops_lost_tracks_and_ids_are_anonymous():
    tr = ByteTracker(max_lost_s=1.0)
    box = np.array([[0, 0, 10, 20.0]])
    tr.update(box, np.array([0.9]), 0.0)
    tr.update(box, np.array([0.9]), 0.2)
    first = tr.tracks[0].id
    tr.update(np.zeros((0, 4)), np.zeros(0), 0.8)
    assert len(tr.tracks) == 1  # coasting
    tr.update(np.zeros((0, 4)), np.zeros(0), 1.5)
    assert tr.tracks == []
    tr.update(box, np.array([0.9]), 1.7)
    assert tr.tracks[0].id != first  # a returning person gets a new id
    prefixes = {ByteTracker()._prefix for _ in range(20)}
    assert len(prefixes) > 1  # prefix is random per tracker/restart (16-bit; 20 equal draws is ~impossible)
    assert all(c in "0123456789abcdef-" for c in first)


# ---- pose metrics, boxes, decoding ----------------------------------------
def test_pose_metrics_and_box_normalization():
    s = np.array([0.9] * 10 + [0.1] * 7, np.float32)
    pq, vis = pose_metrics(s)
    assert pq == pytest.approx(0.9) and vis == pytest.approx(10 / 17)
    assert pose_metrics(None) == (0.0, 0.0) and pose_metrics(np.zeros(17)) == (0.0, 0.0)
    assert normalize_box(np.array([-5, 10, 700, 360]), 640, 360) == [0.0, 0.0278, 1.0, 1.0]
    assert normalize_box(np.array([np.nan, 10, 700, 360]), 640, 360) is None


# ---- pipeline + worker contract ------------------------------------------
class FakeDetector:
    """Stands in for YOLOX: two people, one standing, one lying (wide box)."""
    provider = "fake"

    def __init__(self):
        self.calls = 0
        self.fail = False
        self.nan = False

    def __call__(self, rgb):
        self.calls += 1
        if self.fail:
            raise RuntimeError("inference blew up")
        boxes = np.array([[256, 36, 384, 342], [400, 250, 600, 320]], np.float32)
        if self.nan:
            boxes[1, 0] = np.nan
        return boxes, np.array([0.92, 0.81], np.float32)


class FakePose:
    def __call__(self, rgb, boxes):
        n = len(boxes)
        k = np.zeros((n, 17, 2), np.float32)
        for i, (x1, y1, x2, y2) in enumerate(boxes):
            k[i] = [(x1 + x2) / 2, (y1 + y2) / 2]
        return k, np.full((n, 17), 0.8, np.float32)


def make_pipeline(pose=True):
    det = FakeDetector()
    return PersonPipeline(components=(det, FakePose() if pose else None)), det


def frame(ts, cam="cam1", rgb=True, value=None):
    rng = np.random.default_rng(int(ts * 10))
    gray = rng.integers(40, 200, (90, 160), dtype=np.uint8) if value is None else np.full((90, 160), value, np.uint8)
    return SimpleNamespace(camera_id=cam, wall_ts=ts, gray=gray,
                           rgb=np.zeros((360, 640, 3), np.uint8) if rgb else None)


def worker(det):
    return VisionWorker(WorkerConfig([CameraConfig(id="cam1", url="rtsp://127.0.0.1:1/x")]), det, JsonlSink())


@pytest.mark.parametrize("pose", [True, False])
def test_pipeline_observations_are_schema_valid_people(pose):
    pipe, _ = make_pipeline(pose)
    vw = worker(pipe)
    assert vw.cameras["cam1"].analysis_width == 640  # RGB frames requested from the camera
    obs = [vw.process(frame(1000 + i * 0.2)) for i in range(8)]
    for o in obs:
        jsonschema.validate(o, SCHEMA)
        assert o["source"] == "zeoatap-person-p1" and o["ai_available"] is True
        assert o["frame_size"] == [640, 360]
        assert "UNVALIDATED" in o["model_versions"]["validation"]
        assert ("pose" in o["model_versions"]) is pose
    tracks = sorted(obs[-1]["tracks"], key=lambda t: t["box"][0])
    assert len(tracks) == 2
    assert all(t["role"] == "person" and "held" not in t for t in tracks)
    assert tracks[0]["box"] == [0.4, 0.1, 0.6, 0.95]
    if pose:
        assert tracks[0]["pose_quality"] == pytest.approx(0.8) and tracks[0]["visibility"] == 1.0
    else:
        assert "pose_quality" not in tracks[0]


def test_nan_detections_never_reach_the_json_stream():
    pipe, det = make_pipeline()
    out = io.StringIO()
    vw = VisionWorker(WorkerConfig([CameraConfig(id="cam1", url="rtsp://127.0.0.1:1/x")]), pipe, JsonlSink(out))
    det.nan = True
    for i in range(5):
        vw._analyze_one(frame(1000 + i * 0.2))
    lines = out.getvalue().splitlines()
    assert len(lines) == 5
    for line in lines:
        o = json.loads(line, parse_constant=lambda c: pytest.fail(f"non-JSON constant {c}"))
        jsonschema.validate(o, SCHEMA)
    assert len(json.loads(lines[-1])["tracks"]) == 1  # the NaN person is dropped, the other kept
    assert pipe.invalid_dropped_total >= 5
    # a NaN that slips past the pipeline is dropped at the worker, and a NaN
    # anywhere else makes the sink drop the line rather than write invalid JSON
    from zeoatap_vision.observation import sanitize_tracks
    kept, bad = sanitize_tracks([{"id": "a", "role": "person", "score": float("nan"), "box": [0, 0, 1, 1]},
                                 {"id": "b", "role": "person", "score": 0.5, "box": [0, 0, 1, float("inf")]},
                                 {"id": "c", "role": "person", "score": 0.5, "box": [0, 0, 1, 1]}])
    assert [t["id"] for t in kept] == ["c"] and bad == 2
    sink = JsonlSink(io.StringIO())
    sink.emit({"camera_id": "x", "v": float("nan")})
    assert sink.invalid_total == 1 and sink.written == 0


def test_mock_detector_emits_plausible_schema_valid_people():
    vw = worker(MockDetector())
    seen = set()
    for i in range(300):
        o = vw.process(frame(1000 + i * 0.2, rgb=False))
        jsonschema.validate(o, SCHEMA)
        assert o["source"] == "MOCK"
        for t in o["tracks"]:
            assert t["role"] == "person" and t["box"][0] < t["box"][2] and t["box"][1] < t["box"][3]
            seen.add(t["id"])
    assert seen  # people do appear
    assert MockDetector().analyze("cam-counter", 5.0) == MockDetector().analyze("cam-counter", 5.0)


def test_analysis_loop_survives_exceptions_and_reports_unhealthy():
    class BrokenSink:
        written = 0
        fail = True

        def emit(self, obs):
            if self.fail:
                raise RuntimeError("disk full")
            self.written += 1

    sink = BrokenSink()
    vw = VisionWorker(WorkerConfig([CameraConfig(id="cam1", url="rtsp://127.0.0.1:1/x")]), MockDetector(), sink)
    cam = vw.cameras["cam1"]
    cam.state = cam.state.__class__.STREAMING  # pretend the camera is up
    assert vw.ready()
    vw._analysis.start()  # only the analysis thread; no real camera
    try:
        for i in range(LOOP_FAIL_LIMIT + 2):
            cam._offer(SimpleNamespace(camera_id="cam1", wall_ts=1000 + i * 0.2,
                                       gray=frame(i).gray, rgb=None, frame_size=(1280, 720)))
        end = time.time() + 5
        while vw.loop_errors_total < LOOP_FAIL_LIMIT + 2 and time.time() < end:
            time.sleep(0.01)
        assert vw.loop_errors_total == LOOP_FAIL_LIMIT + 2
        assert vw._analysis.is_alive()  # the thread did not die
        assert not vw.ready() and vw.status()["ai_available"] is False
        assert "disk full" in vw.status()["analysis_loop_last_error"]
        sink.fail = False
        cam._offer(SimpleNamespace(camera_id="cam1", wall_ts=1010.0, gray=frame(9).gray, rgb=None,
                                   frame_size=(1280, 720)))
        end = time.time() + 5
        while sink.written == 0 and time.time() < end:
            time.sleep(0.01)
        assert sink.written == 1 and vw.ready()  # one success clears it
    finally:
        vw._stop.set()
        vw._analysis.join(5)


def test_pipeline_status_is_safe_while_cameras_are_added():
    pipe, _ = make_pipeline(pose=False)
    stop = threading.Event()
    errors = []

    def reader():
        while not stop.is_set():
            try:
                pipe.status()
            except Exception as e:  # pragma: no cover - the bug this guards against
                errors.append(e)

    t = threading.Thread(target=reader)
    t.start()
    try:
        for i in range(300):
            pipe.analyze(f"cam{i}", 1.0, None, np.zeros((36, 64, 3), np.uint8))
    finally:
        stop.set()
        t.join()
    assert not errors and len(pipe.status()["active_tracks"]) == 300


def test_degraded_frames_do_not_run_detection_and_failures_are_explicit():
    pipe, det = make_pipeline()
    vw = worker(pipe)
    # black for > 3 s -> degraded, detector must not run
    for i in range(25):
        o = vw.process(frame(i * 0.2, value=0))
    assert o["quality"] == {"degraded": True, "reason": "black"}
    calls = det.calls
    vw.process(frame(5.2, value=0))
    assert det.calls == calls and o["tracks"] == []
    # inference error: that frame says ai_available=false, never "nobody there"
    vw2 = worker(pipe)
    det.fail = True
    o = vw2.process(frame(100.0))
    jsonschema.validate(o, SCHEMA)
    assert o["ai_available"] is False and o["tracks"] == [] and vw2.analysis_errors_total == 1
    for i in range(3):
        vw2.process(frame(100.2 + i * 0.2))
    assert pipe.available is False  # 3 consecutive failures -> AI_UNAVAILABLE until it recovers
    det.fail = False
    assert vw2.process(frame(101.0))["ai_available"] is False  # gate stays down ...
    pipe.last_error_t -= pipe.RETRY_AFTER_S  # ... until the retry interval passes
    assert vw2.process(frame(101.2))["ai_available"] is True and pipe.available
    # a missing RGB frame is an error, not an empty scene
    assert vw2.process(frame(101.4, rgb=False))["ai_available"] is False


def test_resolve_refuses_missing_or_tampered_models(tmp_path):
    with pytest.raises(ModelMissing):
        resolve("rtmpose-s-body7", tmp_path)
    (tmp_path / "rtmpose-s-body7.onnx").write_bytes(b"not the model")
    with pytest.raises(ModelMissing, match="sha256"):
        resolve("rtmpose-s-body7", tmp_path)
    assert not any(s.kind not in ("detector", "pose") for s in MODELS.values())
