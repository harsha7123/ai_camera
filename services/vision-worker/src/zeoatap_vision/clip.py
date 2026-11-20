"""Write evidence clips by remuxing buffered packets (no decode, no encode).

The ring keeps packets across reconnects, so a clip window can span several
connections ("generations"). Each connection has its own timestamps (they
usually restart, or jump), so every generation is rebased onto one output
timeline placed by wall-clock receive time; an outage shows up as a gap in the
clip, not as spliced video. Generations whose codec parameters differ (e.g.
the camera came back at another resolution) cannot share one MP4 track: only
the codec configuration with the most packets in the window is written, and
the clip is reported partial.

Ring packets are never modified: each one is copied before muxing, because
muxing rescales a packet's timestamps in place and the same packet may go into
later clips."""

from __future__ import annotations

import hashlib
import os
from fractions import Fraction
from pathlib import Path
from typing import Mapping

import av

from .ringbuffer import BufferedPacket

MIN_SEGMENT_GAP_S = 0.04  # between two connections on the clip timeline


def _signature(template) -> tuple:
    cc = template.codec_context
    return (cc.name, cc.width, cc.height, bytes(cc.extradata or b""))


def select_packets(packets: list[BufferedPacket], templates: Mapping[int, object]
                   ) -> tuple[list[BufferedPacket], bool]:
    """Packets that can go into one MP4 track, and whether any were left out
    (no template for their connection, or a different codec configuration).
    Each connection after the first starts at its first keyframe."""
    usable = [bp for bp in packets if bp.gen in templates]
    dropped = len(usable) != len(packets)
    if not usable:
        return [], dropped
    sigs = {g: _signature(templates[g]) for g in {bp.gen for bp in usable}}
    counts: dict[tuple, int] = {}
    for bp in usable:
        counts[sigs[bp.gen]] = counts.get(sigs[bp.gen], 0) + 1
    best = max(counts, key=counts.get)
    out, seen_key, first_gen = [], set(), None
    for bp in usable:
        if sigs[bp.gen] != best:
            dropped = True
            continue
        if first_gen is None:
            first_gen = bp.gen
        if bp.gen not in seen_key:
            if not bp.keyframe:
                dropped = True  # cannot decode before the connection's first keyframe
                continue
            seen_key.add(bp.gen)
        out.append(bp)
    return out, dropped


def _copy(pkt, pts: int | None, dts: int | None, time_base: Fraction, duration: int | None):
    c = av.Packet(bytes(pkt))
    c.time_base = time_base
    c.pts, c.dts = pts, dts
    if duration:
        c.duration = duration
    c.is_keyframe = bool(pkt.is_keyframe)
    return c


def _rebased(packets: list[BufferedPacket]):
    """Yield (packet, pts, dts, duration) on one timeline in the first
    packet's time base, starting at 0."""
    out_tb = Fraction(packets[0].packet.time_base)
    t0_wall = packets[0].wall_ts
    seg_gen, base, tb, seg_start, last_out = None, 0, out_tb, 0, None
    for bp in packets:
        pkt = bp.packet
        ref = pkt.dts if pkt.dts is not None else pkt.pts
        if ref is None:
            continue
        if bp.gen != seg_gen:
            seg_gen, base, tb = bp.gen, ref, Fraction(pkt.time_base)
            if last_out is None:
                seg_start = 0
            else:  # next connection: place it by wall clock, strictly after what was written
                by_wall = round(Fraction(bp.wall_ts - t0_wall) / out_tb)
                seg_start = max(by_wall, last_out + max(1, round(Fraction(MIN_SEGMENT_GAP_S) / out_tb)))

        def conv(v):
            if v is None:
                return None
            d = v - base
            return seg_start + (d if tb == out_tb else round(d * tb / out_tb))

        pts, dts = conv(pkt.pts), conv(pkt.dts)
        dur = pkt.duration if tb == out_tb else (round(pkt.duration * tb / out_tb) if pkt.duration else None)
        last_out = max(v for v in (pts, dts, last_out) if v is not None)
        yield pkt, pts, dts, dur, out_tb


def write_clip(packets: list[BufferedPacket], template, path: str | Path) -> str:
    """Remux packets into an MP4 at path and return the file's SHA-256.

    template is the video stream to copy codec parameters from, or a mapping
    {generation: stream} when packets come from several connections (the
    template of the first packet's generation is used; call select_packets
    first so all packets share one codec configuration).

    The file is written to a temporary name and renamed, so a crash never
    leaves a half-written clip under the final name."""
    if not packets:
        raise ValueError("no packets to write")
    templates = template if isinstance(template, Mapping) else None
    tmpl = templates[packets[0].gen] if templates is not None else template
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.unlink(missing_ok=True)  # never write through a pre-existing file or symlink
    try:
        with av.open(str(tmp), mode="w", format="mp4") as out:
            stream = out.add_stream_from_template(tmpl)
            for pkt, pts, dts, dur, tb in _rebased(packets):
                c = _copy(pkt, pts, dts, tb, dur)
                c.stream = stream
                out.mux(c)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
