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
class CameraConfig:
    id: str
    url: str
    credentials_env: str | None = None
    # Priority cameras (register/POS overheads) are never sampled below 15 fps;
    # everything else runs at 5 fps.
    priority: bool = False
    base_fps: float = 5.0
    priority_fps: float = 15.0
    ring_seconds: float = 120.0
    ring_max_bytes: int = 64 * 1024 * 1024

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
            cam = CameraConfig(**c)
            if not cam.id or cam.id in seen:
                raise ValueError(f"camera id missing or duplicated: {cam.id!r}")
            if "@" in urlsplit(cam.url).netloc:
                raise ValueError(f"camera {cam.id}: put credentials in credentials_env, not in the url")
            seen.add(cam.id)
            cams.append(cam)
        return WorkerConfig(cameras=cams)
