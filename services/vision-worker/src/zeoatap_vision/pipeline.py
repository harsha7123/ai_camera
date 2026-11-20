"""Real detection pipeline (--detector person, or pose):

  RGB frame (~640 px wide) -> YOLOX person detector (ONNX Runtime)
    -> ByteTrack-style tracker (per camera, anonymous short-lived ids)
    -> optional RTMPose on person crops (batched; --detector pose)
       -> pose_quality, visibility
    -> Observation tracks: role "person", boxes normalized to [0,1].

The worker never decides who is staff: every track is role "person" and core
infers staff from staff_area zones and staff_only cameras (ADR-003). There is
no face recognition and no identity; track ids are anonymous and short-lived.

All models are public pretrained weights, NOT validated on restaurant CCTV.
Observations carry the pipeline id in `source` and every model's version in
`model_versions`, so core and reviewers can always tell what ran. The
detector only reports what it sees; rules in core decide.
"""

from __future__ import annotations

import logging
import math
import threading
import time

import numpy as np

from .inference import PersonDetector, PoseEstimator, pick_providers
from .models import DEFAULT_DETECTOR, MODELS, resolve
from .tracker import ByteTracker

log = logging.getLogger(__name__)

PIPELINE_ID = "zeoatap-person-p1"
TRACKER_VERSION = "bytetrack-greedy-v1"
KPT_VISIBLE = 0.3
VALIDATION = "UNVALIDATED-pretrained-weights-not-validated-on-restaurant-cctv"


def pose_metrics(scores: np.ndarray | None) -> tuple[float, float]:
    """pose_quality = mean confidence over visible keypoints (score >= 0.3);
    visibility = fraction of the 17 keypoints that are visible. Both 0 when
    no keypoint is visible."""
    if scores is None or len(scores) == 0:
        return 0.0, 0.0
    vis = scores >= KPT_VISIBLE
    if not vis.any():
        return 0.0, 0.0
    return float(np.clip(scores[vis].mean(), 0, 1)), float(vis.mean())


def normalize_box(box: np.ndarray, w: int, h: int) -> list[float] | None:
    """Normalized [x1,y1,x2,y2] clipped to [0,1]; None if any coordinate is
    not finite (a NaN must never reach the JSON stream)."""
    x1, y1, x2, y2 = (float(v) for v in box)
    b = [x1 / w, y1 / h, x2 / w, y2 / h]
    if not all(math.isfinite(v) for v in b):
        return None
    return [round(min(max(v, 0.0), 1.0), 4) for v in b]


class PersonPipeline:
    name = PIPELINE_ID
    RETRY_AFTER_S = 5.0

    def __init__(self, detector_model: str = DEFAULT_DETECTOR, pose_model: str | None = None,
                 model_dir: str | None = None, device: str = "auto", threads: int | None = None,
                 frame_width: int = 640, max_people: int = 32, components: tuple | None = None):
        """pose_model=None runs detection and tracking only. components=(detector,
        pose_or_None) injects ready callables (tests); otherwise the ONNX models
        are resolved, hash-verified and loaded."""
        dspec = MODELS[detector_model]
        pspec = MODELS[pose_model] if pose_model else None
        if components is not None:
            self.detector, self.pose = components[0], components[1] if len(components) > 1 else None
            if self.pose is None:
                pspec = None
        else:
            providers = pick_providers(device)
            # score_thr 0.1: low-score detections feed ByteTrack's second association stage.
            self.detector = PersonDetector(resolve(detector_model, model_dir), dspec.input_size, providers,
                                           score_thr=0.1, threads=threads)
            self.pose = None
            if pspec is not None:
                self.pose = PoseEstimator(resolve(pose_model, model_dir), pspec.input_size, providers,
                                          threads=threads, max_batch=max_people)
        self.frame_width = frame_width
        self.trackers: dict[str, ByteTracker] = {}
        self.provider = getattr(self.detector, "provider", "injected")
        self.model_versions = {
            "detector": dspec.version,
            "tracker": TRACKER_VERSION,
            "runtime": f"onnxruntime/{self.provider}",
            "validation": VALIDATION,
        }
        if self.pose is not None:
            self.model_versions["pose"] = pspec.version if pspec else "injected"
        self._lock = threading.Lock()  # whole analysis step
        self._state_lock = threading.Lock()  # trackers dict + counters read by status()
        self.loaded = True
        self.frames_total = 0
        self.errors_total = 0
        self.invalid_dropped_total = 0
        self.consecutive_errors = 0
        self.last_error_t = 0.0
        self.last_ms = {"detect": 0.0, "track": 0.0, "pose": 0.0, "total": 0.0}
        self.total_ms_sum = 0.0

    @property
    def available(self) -> bool:
        """False after 3 consecutive failures (core shows AI_UNAVAILABLE); a
        new attempt is allowed every RETRY_AFTER_S and one success restores it."""
        if not self.loaded:
            return False
        return self.consecutive_errors < 3 or time.monotonic() - self.last_error_t >= self.RETRY_AFTER_S

    def detect(self, frame: np.ndarray) -> list[dict]:  # Detector protocol compatibility
        raise RuntimeError("PersonPipeline needs analyze() with an RGB frame")

    def analyze(self, camera_id: str, ts: float, gray: np.ndarray, rgb: np.ndarray | None) -> list[dict]:
        if rgb is None:
            raise ValueError("no RGB frame (camera not configured for analysis frames)")
        with self._lock:  # one analysis thread today; the lock keeps state safe if that changes
            try:
                tracks = self._analyze(camera_id, ts, rgb)
            except Exception:
                self.errors_total += 1
                self.consecutive_errors += 1
                self.last_error_t = time.monotonic()
                raise
            self.consecutive_errors = 0
            return tracks

    def _tracker(self, camera_id: str) -> ByteTracker:
        with self._state_lock:
            tr = self.trackers.get(camera_id)
            if tr is None:
                tr = self.trackers[camera_id] = ByteTracker()
            return tr

    def _analyze(self, camera_id: str, ts: float, rgb: np.ndarray) -> list[dict]:
        t0 = time.perf_counter()
        h, w = rgb.shape[:2]
        boxes, scores = self.detector(rgb)
        boxes = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
        scores = np.asarray(scores, dtype=np.float32).reshape(-1)
        finite = np.isfinite(boxes).all(axis=1) & np.isfinite(scores)
        if not finite.all():  # never let NaN/inf into the tracker's Kalman state
            self.invalid_dropped_total += int((~finite).sum())
            boxes, scores = boxes[finite], scores[finite]
        t1 = time.perf_counter()
        confirmed = self._tracker(camera_id).update(boxes, scores, ts)
        t2 = time.perf_counter()
        det_boxes = np.array([boxes[t.det_index] for t in confirmed], dtype=np.float32).reshape(-1, 4)
        kscores = None
        if self.pose is not None and len(det_boxes):
            _, kscores = self.pose(rgb, det_boxes)
        t3 = time.perf_counter()

        out = []
        for i, t in enumerate(confirmed):
            box = normalize_box(det_boxes[i], w, h)
            score = float(t.score)
            if box is None or not math.isfinite(score):
                self.invalid_dropped_total += 1
                continue
            tr = {"id": t.id, "role": "person", "score": round(min(max(score, 0.0), 1.0), 4), "box": box}
            if kscores is not None and i < len(kscores):
                pq, vis = pose_metrics(kscores[i])
                if math.isfinite(pq) and math.isfinite(vis):
                    tr["pose_quality"], tr["visibility"] = round(pq, 4), round(vis, 4)
            out.append(tr)
        t4 = time.perf_counter()
        self.frames_total += 1
        self.last_ms = {"detect": (t1 - t0) * 1e3, "track": (t2 - t1) * 1e3,
                        "pose": (t3 - t2) * 1e3, "total": (t4 - t0) * 1e3}
        self.total_ms_sum += self.last_ms["total"]
        return out

    def status(self) -> dict:
        with self._state_lock:
            trackers = list(self.trackers.items())
        frames = self.frames_total
        return {
            "pipeline": self.name,
            "provider": self.provider,
            "model_versions": dict(self.model_versions),
            "frames_analyzed_total": frames,
            "inference_errors_total": self.errors_total,
            "invalid_dropped_total": self.invalid_dropped_total,
            "last_ms": {k: round(v, 2) for k, v in dict(self.last_ms).items()},
            "mean_total_ms": round(self.total_ms_sum / frames, 2) if frames else 0.0,
            "active_tracks": {cid: len(t.tracks) for cid, t in trackers},
        }
