"""Camera configuration. Credentials never live in the config file: a camera
names an environment variable (populated from the edge secret store) that
holds "user:password", and URLs are redacted everywhere they are printed."""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class OakOptions:
    """On-camera AI settings for a Luxonis OAK PoE camera (kind "oak").

    The person detector runs on the camera's Myriad X chip; the worker only
    receives detections, a 160x90 grey thumbnail for quality checks and the
    H.264 stream for evidence clips. The model file (.blob) is pinned by
    SHA-256: the worker refuses a file whose hash differs."""
    blob: str
    blob_sha256: str
    model: str = "person-detection-retail-0013"  # OpenVINO Open Model Zoo, Apache-2.0
    nn_size: tuple[int, int] = (544, 320)  # network input (width, height)
    person_labels: tuple[int, ...] = (1,)  # label ids that mean "person" for this model
    confidence: float = 0.5
    video_size: tuple[int, int] = (1920, 1080)  # encoded evidence stream
    fps: float = 15.0  # camera and encoder frame rate
    bitrate_kbps: int = 4000
    keyframe_s: float = 1.0  # one keyframe a second keeps clips starting close to the request

    def __post_init__(self):
        if not re.fullmatch(r"[0-9a-f]{64}", self.blob_sha256 or ""):
            raise ValueError("oak.blob_sha256 must be 64 lowercase hex characters")
        if not (0.0 < self.confidence < 1.0):
            raise ValueError("oak.confidence must be between 0 and 1")
        if not (1.0 <= self.fps <= 60.0) or self.bitrate_kbps < 250 or self.keyframe_s <= 0:
            raise ValueError("oak.fps must be 1-60, bitrate_kbps >= 250, keyframe_s > 0")
        for name, (w, h) in (("nn_size", self.nn_size), ("video_size", self.video_size)):
            if w < 16 or h < 16:
                raise ValueError(f"oak.{name} is too small")
        if not self.person_labels:
            raise ValueError("oak.person_labels must not be empty")

    @staticmethod
    def from_dict(d: dict) -> "OakOptions":
        d = dict(d)
        for k in ("nn_size", "video_size", "person_labels"):
            if k in d:
                d[k] = tuple(d[k])
        return OakOptions(**d)


@dataclass(frozen=True)
class CameraConfig:
    id: str
    url: str
    credentials_env: str | None = None
    # "rtsp": any IP camera; the worker decodes and runs the detector.
    # "oak": a Luxonis OAK PoE camera that runs the detector itself;
    # url is oak://<ip-address-or-mxid>.
    kind: str = "rtsp"
    oak: OakOptions | None = None
    # Priority cameras (register/POS overheads) are never sampled below 15 fps;
    # everything else runs at 5 fps.
    priority: bool = False
    base_fps: float = 5.0
    priority_fps: float = 15.0
    ring_seconds: float = 120.0
    ring_max_bytes: int = 64 * 1024 * 1024

    def __post_init__(self):
        if self.kind not in ("rtsp", "oak"):
            raise ValueError(f"camera {self.id}: kind must be 'rtsp' or 'oak'")
        if self.kind == "oak":
            if self.oak is None:
                raise ValueError(f"camera {self.id}: kind 'oak' needs an 'oak' section (blob, blob_sha256)")
            if not self.url.startswith("oak://") or not self.url[6:]:
                raise ValueError(f"camera {self.id}: an OAK camera's url is oak://<ip-or-mxid>")
            if self.credentials_env:
                raise ValueError(f"camera {self.id}: OAK cameras take no credentials_env")
        elif self.oak is not None:
            raise ValueError(f"camera {self.id}: 'oak' settings need kind 'oak'")

    @property
    def device(self) -> str:
        """OAK device address (IP or MxID) from oak://..."""
        return self.url[6:] if self.kind == "oak" else ""

    @property
    def target_fps(self) -> float:
        return max(self.base_fps, self.priority_fps) if self.priority else self.base_fps

    def resolved_url(self) -> str:
        """URL with credentials injected from the environment. Never log this."""
        if not self.credentials_env:
            return self.url
        creds = os.environ.get(self.credentials_env)
        if not creds or ":" not in creds:
            raise ValueError(f"camera {self.id}: env {self.credentials_env} must hold 'user:password'")
        user, password = creds.split(":", 1)
        parts = urlsplit(self.url)
        # Keep the host part verbatim (minus any userinfo): parts.hostname would
        # strip the brackets of an IPv6 literal such as [fe80::1].
        hostport = parts.netloc.rpartition("@")[2]
        netloc = f"{quote(user, safe='')}:{quote(password, safe='')}@{hostport}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


_CRED_RE = re.compile(r"(?P<scheme>[a-z][a-z0-9+.-]*://)(?P<user>[^:/@\s]+)(:[^@/\s]*)?@", re.I)


def redact(text: str) -> str:
    """Hide credentials in any URL inside text: rtsp://user:****@host."""
    return _CRED_RE.sub(lambda m: f"{m['scheme']}{m['user']}:****@", text)


@dataclass(frozen=True)
class WorkerConfig:
    cameras: list[CameraConfig] = field(default_factory=list)

    @staticmethod
    def load(path: str | Path) -> "WorkerConfig":
        raw = json.loads(Path(path).read_text())
        cams = []
        seen = set()
        for c in raw.get("cameras", []):
            c = dict(c)
            if "protected" in c:  # v1 name; renamed to priority in v2
                if "priority" in c:
                    raise ValueError(f"camera {c.get('id')!r}: use 'priority', not both 'protected' and 'priority'")
                log.warning("camera %s: 'protected' is deprecated, use 'priority'", c.get("id"))
                c["priority"] = c.pop("protected")
            if isinstance(c.get("oak"), dict):
                c["oak"] = OakOptions.from_dict(c["oak"])
            cam = CameraConfig(**c)
            if not cam.id or cam.id in seen:
                raise ValueError(f"camera id missing or duplicated: {cam.id!r}")
            if "@" in urlsplit(cam.url).netloc:
                raise ValueError(f"camera {cam.id}: put credentials in credentials_env, not in the url")
            seen.add(cam.id)
            cams.append(cam)
        return WorkerConfig(cameras=cams)
