"""Observation builder (contract: packages/contracts/observation.schema.json)
and the detector interface. Detectors only report what they see."""

from __future__ import annotations

import json
import logging
import math
import sys
import threading
import zlib
from datetime import datetime, timezone
from typing import Protocol, TextIO

import numpy as np

from .quality import QualityResult

log = logging.getLogger(__name__)


class Detector(Protocol):
    name: str
    available: bool
    model_versions: dict[str, str]

    def detect(self, frame: np.ndarray) -> list[dict]: ...


class NoDetector:
    """No model loaded. Observations still flow so camera health is monitored,
    but ai_available=false makes core report AI_UNAVAILABLE, never green."""

    name = "none"
    available = False
    model_versions: dict[str, str] = {}

    def detect(self, frame: np.ndarray) -> list[dict]:
        return []


class MockDetector:
    """Synthetic restaurant tracks, labelled MOCK end to end. For pipeline and
    UI tests only; it must never be presented as real detection.

    Each camera gets a deterministic (seeded by its id) set of 1-4 people who
    walk across the view on smooth paths, leave and come back with a new
    anonymous id every cycle, like guests and servers moving through a room.
    Output depends only on (camera_id, ts), so replays are reproducible."""

    name = "MOCK"
    available = True
    model_versions = {"detector": "mock-1"}

    def detect(self, frame: np.ndarray) -> list[dict]:
        return []

    def analyze(self, camera_id: str, ts: float, gray=None, rgb=None) -> list[dict]:
        seed = zlib.crc32(camera_id.encode())
        n = 1 + seed % 4
        tracks = []
        for i in range(n):
            s = (seed >> (4 * i)) & 0xFFFF
            period = 40.0 + (s % 50)  # seconds per visit cycle
            phase = (s % 997) / 997.0
            u = (ts / period + phase) % 1.0
            if u > 0.8:  # out of view for the last 20 % of each cycle
                continue
            cycle = int(ts / period + phase)
            x = 0.1 + 0.8 * (0.5 + 0.5 * math.sin(2 * math.pi * u + i))
            y = 0.45 + 0.25 * (0.5 + 0.5 * math.cos(2 * math.pi * u * 0.5 + i))
            w, h = 0.07 + 0.01 * (i % 3), 0.28 + 0.04 * (i % 2)
            box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2]
            tracks.append({
                "id": f"mock-{seed & 0xFFF:03x}-{i}-{cycle}",
                "role": "person",
                "score": round(0.6 + 0.35 * ((s % 100) / 100.0), 4),
                "box": [round(min(max(v, 0.0), 1.0), 4) for v in box],
            })
        return tracks


def iso_utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _unit(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0.0 <= v <= 1.0


def sanitize_tracks(tracks: list[dict]) -> tuple[list[dict], int]:
    """Drop tracks that would make an invalid observation (NaN/inf or out of
    range score/box/pose values, missing id). Returns (kept, dropped_count).
    A model glitch must cost one track, never the whole NDJSON stream."""
    kept = []
    for t in tracks:
        box = t.get("box")
        ok = (isinstance(t.get("id"), str) and t["id"]
              and _unit(t.get("score"))
              and isinstance(box, (list, tuple)) and len(box) == 4 and all(_unit(v) for v in box)
              and all(_unit(t[k]) for k in ("pose_quality", "visibility") if k in t))
        if ok:
            kept.append(t)
    return kept, len(tracks) - len(kept)


def build_observation(camera_id: str, ts: float, quality: QualityResult, detector: Detector,
                      tracks: list[dict], ts_source: str = "receive", ai_available: bool | None = None,
                      frame_size: tuple[int, int] | None = None) -> dict:
    """ai_available defaults to the detector's state; the worker passes False
    for a frame whose inference failed, so an empty track list is never
    mistaken for "nobody there". frame_size is (width, height) of the
    analysed frame; core uses it to turn normalized boxes into real aspect
    ratios."""
    if ai_available is None:
        ai_available = detector.available
    tracks, _ = sanitize_tracks(tracks)
    obs = {
        "camera_id": camera_id,
        "capture_ts": iso_utc(ts),
        "ts_source": ts_source,
        "source": detector.name,
        "model_versions": dict(detector.model_versions),
        "ai_available": bool(ai_available),
        "quality": quality.as_dict(),
    }
    if frame_size and all(isinstance(v, (int, np.integer)) and v >= 1 for v in frame_size):
        obs["frame_size"] = [int(frame_size[0]), int(frame_size[1])]
    obs["tracks"] = tracks
    return obs


def dumps_observation(obs: dict) -> str:
    """Strict JSON: raises ValueError on NaN/inf instead of writing invalid JSON."""
    return json.dumps(obs, separators=(",", ":"), allow_nan=False)


class JsonlSink:
    """Thread-safe JSON-lines writer (stdout or a file). The gRPC stream to
    core replaces this in a later task; the payload stays the same."""

    def __init__(self, out: TextIO | None = None):
        self._out = out or sys.stdout
        self._lock = threading.Lock()
        self.written = 0
        self.invalid_total = 0

    def emit(self, obs: dict) -> None:
        try:
            line = dumps_observation(obs)
        except ValueError as e:
            self.invalid_total += 1
            log.warning("dropped an observation that is not valid JSON: %s", e)
            return
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()
            self.written += 1

    def status(self) -> dict:
        return {"kind": "jsonl", "written_total": self.written, "invalid_total": self.invalid_total}
