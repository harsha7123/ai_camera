"""Luxonis OAK PoE cameras (kind "oak"): person detection runs on the camera.

An OAK-1 PoE has its own AI chip (Intel Myriad X). This adapter loads a
person detector onto it and receives three small streams over the camera's
single PoE cable:

  "h264"   the encoded video, buffered exactly like an RTSP camera's packets,
           so evidence clips are cut by the same remux code (no re-encode);
  "thumb"  a 160x90 grey thumbnail of each analysed frame, for the same
           black / obstructed / frozen quality checks as every other camera;
  "dets"   the detector's boxes for that frame (paired with the thumbnail by
           sequence number).

The host decodes no video and runs no neural network for these cameras; it
only runs the cheap ByteTrack-style tracker so track ids behave exactly like
on RTSP cameras. Output is the same anonymous Observation (role "person"); core
cannot tell the difference except through `source` and `model_versions`.

Device access goes through a small OakSource/OakSession interface. The real
implementation (DepthAISource) uses DepthAI v2 (pip extra "oak"), which can
build and check the on-camera pipeline without hardware; tests use a fake
source. Nothing here identifies anyone (ADR-003).

Model: OpenVINO Open Model Zoo person-detection-retail-0013 (Apache-2.0),
compiled for the Myriad X as a .blob. It is pinned by SHA-256 in the camera
config; a file with another hash is refused. UNVALIDATED on restaurant CCTV.
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
import time
from fractions import Fraction
from pathlib import Path
from typing import Callable, Protocol

import av
import numpy as np

from .camera import CameraWorker, ClipTemplate, SampledFrame, StreamState
from .config import CameraConfig, OakOptions
from .timing import Backoff
from .tracker import ByteTracker

log = logging.getLogger(__name__)

PIPELINE_ID = "zeoatap-oak-p1"
TRACKER_VERSION = "bytetrack-greedy-v1"  # same tracker as the RTSP pipeline
THUMB_W, THUMB_H = 160, 90
TIME_BASE = Fraction(1, 90000)
# With no detections for this long while thumbnails keep coming, the on-camera
# network is considered stalled: frames are sent with ai_available=false, so
# core shows AI_UNAVAILABLE (never green) instead of "nobody there".
NN_STALL_S = 1.5
# A device timestamp further than this from the host clock is not trusted.
MAX_CLOCK_SKEW_S = 5.0
MAX_PENDING_THUMBS = 60

# Message from a session: (kind, device_ts_seconds, sequence_number, payload)
#   kind "h264":  payload = bytes (one Annex-B access unit)
#   kind "thumb": payload = np.ndarray uint8 (H, W)
#   kind "dets":  payload = list of (label, confidence, xmin, ymin, xmax, ymax), coords normalized
Message = tuple[str, float, int, object]


class OakSession(Protocol):
    def poll(self, timeout: float) -> list[Message]: ...
    def close(self) -> None: ...


class OakSource(Protocol):
    def connect(self, cam: CameraConfig) -> OakSession: ...


class BlobMismatch(RuntimeError):
    """The model file on disk is not the one pinned in the camera config."""


# ---- helpers ---------------------------------------------------------------

def nal_types(data: bytes) -> list[int]:
    """H.264 NAL unit types in an Annex-B access unit."""
    out, i = [], 0
    while True:
        j = data.find(b"\x00\x00\x01", i)
        if j < 0 or j + 3 >= len(data):
            return out
        out.append(data[j + 3] & 0x1F)
        i = j + 3


def is_keyframe(data: bytes) -> bool:
    return 5 in nal_types(data)  # IDR slice


def verify_blob(opts: OakOptions) -> Path:
    """Check the model file against its pinned SHA-256 before it goes to a camera."""
    p = Path(opts.blob)
    if not p.is_file():
        raise FileNotFoundError(f"OAK model blob not found: {p} (see scripts/fetch_oak_model.py)")
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != opts.blob_sha256:
        raise BlobMismatch(f"OAK model blob {p.name} has sha256 {h.hexdigest()}, config pins {opts.blob_sha256}")
    return p


def model_versions(opts: OakOptions, runtime: str = "") -> dict[str, str]:
    mv = {"detector": f"{opts.model}@{opts.blob_sha256[:12]}", "tracker": TRACKER_VERSION,
          "on_camera": "true"}
    if runtime:
        mv["runtime"] = runtime
    return mv


def person_boxes(dets, opts: OakOptions) -> tuple[np.ndarray, np.ndarray]:
    """Person detections in video pixels (xyxy) and their scores. Drops other
    labels, low scores, non-finite or empty boxes; clips to the frame."""
    W, H = opts.video_size
    boxes, scores = [], []
    for label, conf, x1, y1, x2, y2 in dets:
        vals = (conf, x1, y1, x2, y2)
        if int(label) not in opts.person_labels or not all(math.isfinite(float(v)) for v in vals):
            continue
        if conf < opts.confidence:
            continue
        x1, x2 = sorted((min(max(float(x1), 0.0), 1.0), min(max(float(x2), 0.0), 1.0)))
        y1, y2 = sorted((min(max(float(y1), 0.0), 1.0), min(max(float(y2), 0.0), 1.0)))
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            continue
        boxes.append([x1 * W, y1 * H, x2 * W, y2 * H])
        scores.append(min(max(float(conf), 0.0), 1.0))
    return np.asarray(boxes, dtype=np.float32).reshape(-1, 4), np.asarray(scores, dtype=np.float32)


# ---- camera worker ---------------------------------------------------------

class OakCameraWorker(CameraWorker):
    """A CameraWorker whose video and detections come from an OAK camera.
    Ring buffer, clip jobs, analysis queue, status and reconnect/backoff are
    inherited unchanged; only the stream loop differs."""

    def __init__(self, cfg: CameraConfig, source: OakSource, queue_size: int = 8,
                 read_timeout_s: float = 3.0, backoff: Backoff | None = None,
                 clock: Callable[[], float] = time.time, mono: Callable[[], float] = time.monotonic,
                 runtime: str = ""):
        if cfg.kind != "oak" or cfg.oak is None:
            raise ValueError(f"camera {cfg.id} is not an OAK camera")
        super().__init__(cfg, queue_size=queue_size, read_timeout_s=read_timeout_s, backoff=backoff,
                         clock=clock, analysis_width=None)
        self.source = source
        self.opts = cfg.oak
        self._mono = mono
        self.tracker = ByteTracker()
        self.model_versions = model_versions(cfg.oak, runtime)
        self.nn_frames_total = 0
        self.nn_stalled_frames_total = 0
        self.h264_before_keyframe_total = 0
        self._last_pts: int | None = None
        self._frame_dur = max(1, round(1 / (self.opts.fps * TIME_BASE)))

    def status(self) -> dict:
        st = super().status()
        st.update({"kind": "oak", "device": self.cfg.device, "model": self.model_versions["detector"],
                   "nn_frames_total": self.nn_frames_total,
                   "nn_stalled_frames_total": self.nn_stalled_frames_total,
                   "h264_before_keyframe_total": self.h264_before_keyframe_total})
        return st

    def _wall(self, device_ts: float, now: float) -> float:
        """Device timestamps are on the host's monotonic clock (DepthAI syncs
        them); map to wall time, or fall back to receive time if implausible."""
        w = device_ts + (self._clock() - self._mono())
        return w if abs(w - now) <= MAX_CLOCK_SKEW_S else now

    def _stream_once(self) -> None:
        session = self.source.connect(self.cfg)
        try:
            self._gen += 1
            gen = self._gen
            self._last_pts = None
            thumbs: dict[int, tuple[float, np.ndarray]] = {}
            last_nn: float | None = None
            idle_since = self._mono()
            first = True
            while not self._stop.is_set():
                msgs = session.poll(min(0.5, self._read_timeout))
                now = self._clock()
                if not msgs and self._mono() - idle_since > self._read_timeout:
                    raise TimeoutError("no data from the OAK camera")
                if msgs:
                    idle_since = self._mono()
                    if first:
                        self._set_state(StreamState.STREAMING)
                        self.backoff.reset()
                        first = False
                for kind, ts, seq, payload in msgs:
                    wall = self._wall(float(ts), now)
                    if kind == "h264":
                        self._on_h264(bytes(payload), wall, gen)
                    elif kind == "thumb":
                        thumbs[int(seq)] = (wall, payload)
                    elif kind == "dets":
                        entry = thumbs.pop(int(seq), None)
                        if entry is not None:
                            last_nn = now
                            self._emit(entry[0], entry[1], payload)
                # Thumbnails the network skipped are dropped while it is
                # healthy (it runs slower than the camera); if it has gone
                # silent they become ai_available=false frames.
                stalled = last_nn is None or now - last_nn > NN_STALL_S
                for seq in sorted(thumbs):
                    w, g = thumbs[seq]
                    if now - w > NN_STALL_S or len(thumbs) > MAX_PENDING_THUMBS:
                        del thumbs[seq]
                        if stalled:
                            self._emit(w, g, None)
                self._finish_clip_jobs()
        finally:
            try:
                session.close()
            finally:
                self._finish_clip_jobs(force=True)
        if not self._stop.is_set():
            raise ConnectionError("OAK stream ended")

    def _on_h264(self, data: bytes, wall: float, gen: int) -> None:
        key = is_keyframe(data)
        if gen not in self._templates:
            if not key:
                self.h264_before_keyframe_total += 1  # cannot decode before the first keyframe
                return
            with av.open(io.BytesIO(data), format="h264") as c:
                self._templates[gen] = ClipTemplate(c.streams.video[0])
            live = self.ring.generations() | {gen}
            for g in [g for g in self._templates if g not in live]:
                del self._templates[g]
        pkt = av.Packet(data)
        pkt.time_base = TIME_BASE
        pts = round(wall / TIME_BASE)
        if self._last_pts is not None and pts <= self._last_pts:
            pts = self._last_pts + 1  # strictly increasing, whatever the clock does
        self._last_pts = pts
        pkt.pts = pkt.dts = pts
        pkt.duration = self._frame_dur
        pkt.is_keyframe = key
        self.stats.packets_total += 1
        self.ring.append(pkt, wall, gen)

    def _emit(self, wall: float, gray, dets) -> None:
        tracks = None
        if dets is not None:
            self.nn_frames_total += 1
            boxes, scores = person_boxes(dets, self.opts)
            W, H = self.opts.video_size
            tracks = []
            for t in self.tracker.update(boxes, scores, wall):
                b = boxes[t.det_index]
                box = [round(min(max(float(v), 0.0), 1.0), 4) for v in (b[0] / W, b[1] / H, b[2] / W, b[3] / H)]
                tracks.append({"id": t.id, "role": "person", "score": round(min(max(float(t.score), 0.0), 1.0), 4),
                               "box": box})
        else:
            self.nn_stalled_frames_total += 1
        if not self.sampler.should_sample(wall):
            return
        g = np.asarray(gray, dtype=np.uint8)
        if g.shape != (THUMB_H, THUMB_W):
            g = _resize_gray(g, THUMB_W, THUMB_H)
        self.stats.frames_sampled_total += 1
        self._offer(SampledFrame(self.cfg.id, wall, g, None, tuple(self.opts.video_size),
                                 onboard=True, tracks=tracks, source=PIPELINE_ID,
                                 model_versions=dict(self.model_versions)))


def _resize_gray(g: np.ndarray, w: int, h: int) -> np.ndarray:
    """Nearest-neighbour resize, so quality checks always see 160x90."""
    if g.ndim != 2 or g.size == 0:
        return np.zeros((h, w), np.uint8)
    ys = (np.arange(h) * g.shape[0] / h).astype(int)
    xs = (np.arange(w) * g.shape[1] / w).astype(int)
    return g[ys][:, xs]


# ---- DepthAI (real hardware) -------------------------------------------------

def import_depthai():
    try:
        import depthai  # noqa: PLC0415
    except ImportError as e:  # pragma: no cover - depends on the optional extra
        raise ImportError("OAK cameras need DepthAI: uv sync --extra oak") from e
    if not depthai.__version__.startswith("2."):
        raise ImportError(f"this adapter targets DepthAI 2.x, found {depthai.__version__}")
    return depthai


def build_pipeline(dai, opts: OakOptions, blob_path: Path | None):
    """The on-camera graph:

      ColorCamera ─ video ─▶ VideoEncoder (H.264 main, no B-frames) ─▶ "h264"
                  └ preview (nn_size, BGR planar) ─▶ MobileNetDetectionNetwork ─▶ "dets"
                                                   └▶ ImageManip (160x90 GRAY8) ─▶ "thumb"

    Detections and thumbnails come from the same preview frame, so their
    sequence numbers match. The network's input never blocks the camera: if
    it is slower than the camera it skips frames.

    blob_path None builds the graph without loading a model; tests use it to
    check the pipeline offline (DepthAI parses the blob on load)."""
    p = dai.Pipeline()
    cam = p.create(dai.node.ColorCamera)
    cam.setBoardSocket(dai.CameraBoardSocket.CAM_A)
    res = dai.ColorCameraProperties.SensorResolution
    cam.setResolution(res.THE_4_K if opts.video_size[0] > 1920 or opts.video_size[1] > 1080 else res.THE_1080_P)
    cam.setVideoSize(*opts.video_size)
    cam.setFps(float(opts.fps))
    cam.setPreviewSize(*opts.nn_size)
    cam.setPreviewKeepAspectRatio(False)  # whole field of view, so boxes map onto the full video frame
    cam.setInterleaved(False)
    cam.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)

    enc = p.create(dai.node.VideoEncoder)
    enc.setDefaultProfilePreset(float(opts.fps), dai.VideoEncoderProperties.Profile.H264_MAIN)
    enc.setKeyframeFrequency(max(1, round(opts.fps * opts.keyframe_s)))
    enc.setNumBFrames(0)
    enc.setBitrateKbps(int(opts.bitrate_kbps))
    cam.video.link(enc.input)

    nn = p.create(dai.node.MobileNetDetectionNetwork)
    if blob_path is not None:
        nn.setBlobPath(str(blob_path))
    nn.setConfidenceThreshold(float(opts.confidence))
    nn.setNumInferenceThreads(2)
    nn.input.setBlocking(False)
    nn.input.setQueueSize(1)
    cam.preview.link(nn.input)

    manip = p.create(dai.node.ImageManip)
    manip.initialConfig.setResize(THUMB_W, THUMB_H)
    manip.initialConfig.setFrameType(dai.ImgFrame.Type.GRAY8)
    manip.setMaxOutputFrameSize(THUMB_W * THUMB_H)
    manip.inputImage.setBlocking(False)
    manip.inputImage.setQueueSize(2)
    cam.preview.link(manip.inputImage)

    for name, out in (("h264", enc.bitstream), ("dets", nn.out), ("thumb", manip.out)):
        x = p.create(dai.node.XLinkOut)
        x.setStreamName(name)
        out.link(x.input)
    return p


class DepthAISession:
    def __init__(self, dai, device):
        self.device = device
        # Losing an H.264 packet corrupts video until the next keyframe, so its
        # host queue is deep (8 s at 15 fps); thumbnails and detections are cheap to drop.
        sizes = {"h264": 120, "thumb": 30, "dets": 30}
        self.queues = {n: device.getOutputQueue(n, maxSize=k, blocking=False) for n, k in sizes.items()}

    def poll(self, timeout: float) -> list[Message]:
        deadline = time.monotonic() + timeout
        while True:
            if self.device.isClosed():
                raise ConnectionError("OAK device closed")
            out: list[Message] = []
            for name, q in self.queues.items():
                for m in q.tryGetAll():
                    out.append(self._convert(name, m))
            if out or time.monotonic() >= deadline:
                return out
            time.sleep(0.005)

    @staticmethod
    def _convert(name: str, m) -> Message:
        ts, seq = m.getTimestamp().total_seconds(), m.getSequenceNum()
        if name == "h264":
            return name, ts, seq, bytes(m.getData())
        if name == "thumb":
            g = np.asarray(m.getData(), dtype=np.uint8).reshape(m.getHeight(), m.getWidth())
            return name, ts, seq, g
        dets = [(d.label, d.confidence, d.xmin, d.ymin, d.xmax, d.ymax) for d in m.detections]
        return name, ts, seq, dets

    def close(self) -> None:
        self.device.close()


class DepthAISource:
    """Connects to an OAK PoE camera by IP address or MxID (url oak://...)."""

    def __init__(self):
        self.dai = import_depthai()
        self.runtime = f"depthai-{self.dai.__version__}"

    def connect(self, cam: CameraConfig) -> DepthAISession:
        blob = verify_blob(cam.oak)
        pipeline = build_pipeline(self.dai, cam.oak, blob)
        info = self.dai.DeviceInfo(cam.device)
        device = self.dai.Device(pipeline, info)
        return DepthAISession(self.dai, device)
