"""One camera: connect, demux, buffer packets, decode, sample, and hand frames
to analysis through a bounded drop-oldest queue. Reconnects forever with
backoff; every state change is visible through status().

The packet ring is NOT cleared on reconnect: the video from before an outage
is often the evidence that matters (camera_tamper, after_hours_intrusion).
The ring's age and byte bounds remove stale packets. Each connection is a new
"generation" with its own clip template, and clip.write_clip rebases
timestamps across generations."""

from __future__ import annotations

import io
import logging
import threading
import time
from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable

import av

from .clip import select_packets, write_clip
from .config import CameraConfig, redact
from .ringbuffer import PacketRingBuffer
from .timing import Backoff, FrameSampler

log = logging.getLogger(__name__)

THUMB_W, THUMB_H = 160, 90
# A clip is partial when the buffer starts more than this after the requested
# start, or has a hole longer than CLIP_GAP_S (outage, eviction).
CLIP_START_TOL_S = 0.5
CLIP_GAP_S = 3.0


class NoVideoError(RuntimeError):
    """The ring buffer holds no video for the requested clip window."""


def analysis_size(src_w: int, src_h: int, target_w: int) -> tuple[int, int]:
    """Keep aspect ratio, never upscale, even dimensions (for the scaler)."""
    w = min(target_w, src_w)
    h = max(2, int(round(src_h * w / src_w / 2)) * 2)
    return w - (w % 2), h


class StreamState(str, Enum):
    CONNECTING = "CONNECTING"
    STREAMING = "STREAMING"
    RECONNECTING = "RECONNECTING"
    STOPPED = "STOPPED"


@dataclass
class SampledFrame:
    camera_id: str
    wall_ts: float
    gray: object  # numpy uint8 thumbnail
    rgb: object = None  # numpy uint8 HxWx3, ~analysis_width wide; only when a real detector runs
    frame_size: tuple[int, int] | None = None  # (w, h) of the analysed frame (rgb if present, else decoded)
    # On-camera AI (OAK): the camera already detected and the worker tracked.
    # tracks None with onboard=True means the camera's network gave no result.
    onboard: bool = False
    tracks: list | None = None
    source: str | None = None
    model_versions: dict | None = None


@dataclass
class _ClipJob:
    start: float
    end: float
    path: Path
    deadline: float
    future: Future = field(default_factory=Future)


class ClipTemplate:
    """Codec parameters of one connection, copied into a private (never
    opened) output container so they stay valid after the input container is
    closed. The input stream's own parameters are freed when it closes."""

    def __init__(self, video):
        self._holder = av.open(io.BytesIO(), mode="w", format="mp4")
        self.stream = self._holder.add_stream_from_template(video)


def _max_gap(pkts) -> float:
    return max((b.wall_ts - a.wall_ts for a, b in zip(pkts, pkts[1:])), default=0.0)


@dataclass
class CameraStats:
    packets_total: int = 0
    frames_decoded_total: int = 0
    frames_sampled_total: int = 0
    frames_dropped_total: int = 0  # analysis queue overflow
    decode_errors_total: int = 0
    reconnects_total: int = 0
    clips_written_total: int = 0
    last_error: str = ""


class CameraWorker:
    def __init__(self, cfg: CameraConfig, queue_size: int = 8,
                 open_timeout_s: float = 5.0, read_timeout_s: float = 3.0,
                 backoff: Backoff | None = None, clock: Callable[[], float] = time.time,
                 analysis_width: int | None = None):
        self.cfg = cfg
        self.ring = PacketRingBuffer(cfg.ring_seconds, cfg.ring_max_bytes)
        self.sampler = FrameSampler(cfg.target_fps)
        self.backoff = backoff or Backoff()
        self.stats = CameraStats()
        self.state = StreamState.CONNECTING
        self._queue: deque[SampledFrame] = deque()
        self._queue_size = queue_size
        # Width of the RGB analysis frame (None = gray thumbnail only). Memory
        # stays bounded: queue_size frames of ~640x360x3 bytes per camera.
        self.analysis_width = analysis_width
        self._qlock = threading.Lock()
        self._open_timeout, self._read_timeout = open_timeout_s, read_timeout_s
        self._clock = clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._templates: dict[int, ClipTemplate] = {}
        self._gen = 0
        self._clip_jobs: list[_ClipJob] = []
        self._clip_lock = threading.Lock()
        self.state_since = clock()

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"cam-{self.cfg.id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)
        self._finish_clip_jobs(force=True)  # anything left fails with a reported error
        self._set_state(StreamState.STOPPED)

    # ---- analysis queue --------------------------------------------------
    def take_frame(self) -> SampledFrame | None:
        with self._qlock:
            return self._queue.popleft() if self._queue else None

    def _offer(self, f: SampledFrame) -> None:
        with self._qlock:
            if len(self._queue) >= self._queue_size:
                self._queue.popleft()
                self.stats.frames_dropped_total += 1
            self._queue.append(f)

    # ---- clips -----------------------------------------------------------
    def request_clip(self, start: float, end: float, path: str | Path, wait_s: float = 120.0) -> Future:
        """Clip [start, end] (wall clock). Resolves to (path, sha256, partial)."""
        job = _ClipJob(start, end, Path(path), deadline=end + wait_s)
        with self._clip_lock:
            self._clip_jobs.append(job)
        return job.future

    def _finish_clip_jobs(self, force: bool = False) -> None:
        if not self._clip_jobs:
            return
        newest = self.ring.newest_ts
        templates = {g: t.stream for g, t in list(self._templates.items())}
        with self._clip_lock:
            jobs, self._clip_jobs = self._clip_jobs, []
        keep = []
        for job in jobs:
            ready = newest is not None and newest >= job.end
            if not (ready or force or self._clock() >= job.deadline):
                keep.append(job)
                continue
            try:
                pkts, dropped = select_packets(self.ring.snapshot(job.start, job.end), templates)
                if not pkts:
                    raise NoVideoError("no buffered video covers the requested window")
                sha = write_clip(pkts, templates, job.path)
                self.stats.clips_written_total += 1
                partial = (not ready or dropped
                           or pkts[0].wall_ts > job.start + CLIP_START_TOL_S  # ring no longer reaches start
                           or job.end - pkts[-1].wall_ts > CLIP_GAP_S
                           or _max_gap(pkts) > CLIP_GAP_S)
                job.future.set_result((job.path, sha, partial))
            except Exception as e:  # report, never crash the camera loop
                job.future.set_exception(e)
        with self._clip_lock:
            self._clip_jobs.extend(keep)

    # ---- main loop -------------------------------------------------------
    def status(self) -> dict:
        oldest, newest, nbytes, _ = self.ring.span()  # one consistent read
        state, since = self.state, self.state_since
        return {
            "camera_id": self.cfg.id,
            "state": state.value,
            "state_since": since,
            "ring_seconds": (newest - oldest) if oldest is not None else 0.0,
            "ring_bytes": nbytes,
            **dict(self.stats.__dict__),
        }

    def _set_state(self, s: StreamState) -> None:
        if s != self.state:
            log.info("camera %s: %s -> %s", self.cfg.id, self.state.value, s.value)
            self.state, self.state_since = s, self._clock()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._stream_once()
            except Exception as e:
                self.stats.last_error = redact(f"{type(e).__name__}: {e}")
                log.warning("camera %s: %s", self.cfg.id, self.stats.last_error)
            if self._stop.is_set():
                break
            self._set_state(StreamState.RECONNECTING)
            self.stats.reconnects_total += 1
            self._finish_clip_jobs()
            self._stop.wait(self.backoff.next_delay())

    def _stream_once(self) -> None:
        url = self.cfg.resolved_url()
        opts = {"rtsp_transport": "tcp"} if url.startswith(("rtsp://", "rtsps://")) else {}
        with av.open(url, options=opts, timeout=(self._open_timeout, self._read_timeout)) as container:
            video = next((s for s in container.streams if s.type == "video"), None)
            if video is None:
                raise RuntimeError("stream has no video track")
            video.thread_type = "AUTO"
            self._gen += 1
            gen = self._gen
            self._templates[gen] = ClipTemplate(video)
            live = self.ring.generations() | {gen}
            for g in [g for g in self._templates if g not in live]:
                del self._templates[g]
            try:
                self._demux(container, video, gen)
            finally:
                # The stream is gone: write pending clips now with what was
                # buffered; they end early, so they are marked partial.
                self._finish_clip_jobs(force=True)
        if not self._stop.is_set():
            raise ConnectionError("stream ended")

    def _demux(self, container, video, gen: int = 0) -> None:
        first_packet = True
        for packet in container.demux(video):
            if self._stop.is_set():
                return
            if packet.size == 0:  # flush packet at end of stream
                continue
            now = self._clock()
            if first_packet:
                self._set_state(StreamState.STREAMING)
                self.backoff.reset()
                first_packet = False
            self.stats.packets_total += 1
            self.ring.append(packet, now, gen)
            try:
                frames = packet.decode()
            except av.error.InvalidDataError:
                self.stats.decode_errors_total += 1
                continue
            for frame in frames:
                self.stats.frames_decoded_total += 1
                if self.sampler.should_sample(now):
                    gray = frame.reformat(width=THUMB_W, height=THUMB_H, format="gray").to_ndarray()
                    rgb, size = None, (frame.width, frame.height)
                    if self.analysis_width:
                        size = analysis_size(frame.width, frame.height, self.analysis_width)
                        rgb = frame.reformat(width=size[0], height=size[1], format="rgb24").to_ndarray()
                    self.stats.frames_sampled_total += 1
                    self._offer(SampledFrame(self.cfg.id, now, gray, rgb, size))
            self._finish_clip_jobs()
