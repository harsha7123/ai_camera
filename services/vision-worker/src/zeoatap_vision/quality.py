"""Frame-quality checks on a small grayscale thumbnail. A camera that shows a
black, covered or frozen image is reported as degraded; it is never treated
as "nothing happening".

Frozen means consecutive thumbnails are (near-)bit-identical: no pixel
differs by more than frozen_max_delta (1 grey level, which tolerates
rounding but not sensor or encoder noise) for frozen_after_s. That is the
signature of a stalled encoder or decoder repeating frames. A live camera
always shows some sensor noise, so a legitimately still scene (an empty
dining room or kitchen at night) is NOT flagged; flagging it would skip
detection (no after-hours intrusion) and raise camera_tamper every night.

Known limitation: a camera whose sensor stalls but keeps updating an OSD
clock overlay, or whose encoder adds fresh noise to a repeated image, is not
detected as frozen. Stall detection at the RTP/timestamp level is the
roadmap fix."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

REASON_BLACK = "black"
REASON_OBSTRUCTED = "obstructed"
REASON_FROZEN = "frozen"


@dataclass
class QualityThresholds:
    black_mean: float = 16.0  # mean luma (0-255) below this is "black"
    obstructed_std: float = 6.0  # almost no texture, e.g. a covered lens
    black_after_s: float = 3.0
    obstructed_after_s: float = 5.0
    # Consecutive thumbnails with no pixel differing by more than
    # frozen_max_delta, for this long (see the module docstring).
    frozen_after_s: float = 30.0
    frozen_max_delta: int = 1
    recover_after_s: float = 5.0


@dataclass(frozen=True)
class QualityResult:
    degraded: bool
    reason: str = ""

    def as_dict(self) -> dict:
        return {"degraded": self.degraded, "reason": self.reason}


class QualityMonitor:
    def __init__(self, thresholds: QualityThresholds | None = None):
        self.t = thresholds or QualityThresholds()
        self._since: dict[str, float] = {}
        self._prev: np.ndarray | None = None
        self._prev_ts = 0.0
        self._current = QualityResult(False)
        self._ok_since: float | None = None

    def update(self, gray: np.ndarray, ts: float) -> QualityResult:
        mean = float(gray.mean())
        std = float(gray.std())
        frozen = self._repeated(gray)
        run_start = self._prev_ts  # a frozen run starts at the first of the repeated frames
        self._prev, self._prev_ts = gray.astype(np.int16), ts

        raw = {
            REASON_BLACK: mean < self.t.black_mean,
            REASON_OBSTRUCTED: mean >= self.t.black_mean and std < self.t.obstructed_std,
            REASON_FROZEN: frozen,
        }
        for reason, active in raw.items():
            if active:
                self._since.setdefault(reason, run_start if reason == REASON_FROZEN else ts)
            else:
                self._since.pop(reason, None)

        after = {
            REASON_BLACK: self.t.black_after_s,
            REASON_OBSTRUCTED: self.t.obstructed_after_s,
            REASON_FROZEN: self.t.frozen_after_s,
        }
        firing = [r for r in (REASON_BLACK, REASON_OBSTRUCTED, REASON_FROZEN)
                  if r in self._since and ts - self._since[r] >= after[r]]

        if firing:
            self._current = QualityResult(True, firing[0])
            self._ok_since = None
        elif self._current.degraded:
            # Hysteresis: stay degraded until the image has been good for a while.
            if any(raw.values()):
                self._ok_since = None
            elif self._ok_since is None:
                self._ok_since = ts
            elif ts - self._ok_since >= self.t.recover_after_s:
                self._current = QualityResult(False)
                self._ok_since = None
        return self._current

    def _repeated(self, gray: np.ndarray) -> bool:
        a = self._prev
        if a is None or a.shape != gray.shape:
            return False
        return int(np.abs(gray.astype(np.int16) - a).max()) <= self.t.frozen_max_delta
