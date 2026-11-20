"""Generate the MOCK replay fixture for Harbor Grill (services/core/site.example.json).

Scenario, Tuesday 2026-10-27 from 14:00 New York time (restaurant open), 36 s:
  cam-counter   staff member behind register 1 the whole time; a customer at the
                register front for the first 4 s; POS: sale at 3 s (customer
                present: fine), no-sale at 5 s, refund $42.10 at 30 s with nobody at
                the counter.
  cam-entrance  two people walk in (cross the door line downwards), one walks out.
  cam-dining    a person not known as staff stands at the office door 2-7 s;
                a person lies on the dining floor 10-14 s.
  cam-kitchen   a cook walks into the walk-in cooler 15-20 s.

Expected replay result (rules in their default SHADOW/review state):
  restricted_zone_entry REVIEW_QUEUED, person_down SHADOW, pos_no_sale REVIEW_QUEUED,
  pos_refund_no_customer SHADOW, one staff cooler visit in the access log,
  2 entries and 1 exit at the front door.

Run:  python3 generate_mock.py   (writes mock_observations.jsonl and mock_pos.jsonl)
Every observation is marked source=MOCK: none of this is a real detection.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

T0 = datetime(2026, 10, 27, 18, 0, 0, tzinfo=timezone.utc)  # 14:00 America/New_York
STEP = 0.5
DURATION = 36.0
HERE = Path(__file__).resolve().parent


def ts(sec: float) -> str:
    return (T0 + timedelta(seconds=sec)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def standing(tid: str, x: float, y: float) -> dict:
    return {"id": tid, "role": "person", "score": 0.9,
            "box": [round(x - 0.04, 4), round(max(0.0, y - 0.3), 4), round(x + 0.04, 4), round(y, 4)],
            "visibility": 1.0}


def lying(tid: str, x: float, y: float) -> dict:
    return {"id": tid, "role": "person", "score": 0.8,
            "box": [round(x - 0.15, 4), round(y - 0.05, 4), round(x + 0.15, 4), round(y + 0.05, 4)],
            "visibility": 1.0}


def tracks(cam: str, t: float) -> list:
    out = []
    if cam == "cam-counter":
        out.append(standing("s1", 0.5, 0.2))
        if t < 4:
            out.append(standing("c1", 0.5, 0.6))
    elif cam == "cam-entrance":
        for tid, start, down in (("e1", 1.0, True), ("e2", 3.0, True), ("e3", 6.0, False)):
            if start <= t <= start + 2.0:
                frac = (t - start) / 2.0
                y = 0.5 + 0.4 * frac if down else 0.9 - 0.4 * frac
                out.append(standing(tid, 0.5, y))
    elif cam == "cam-dining":
        if 2 <= t <= 7:
            out.append(standing("d1", 0.92, 0.55))
        if 10 <= t <= 14:
            out.append(lying("d2", 0.5, 0.8))
    elif cam == "cam-kitchen":
        out.append(standing("k1", 0.4, 0.8))
        if 15 <= t <= 20:
            out.append(standing("k2", 0.85, 0.6))
    return out


def main() -> None:
    cams = ["cam-counter", "cam-entrance", "cam-dining", "cam-kitchen", "cam-back"]
    lines = []
    n = int(DURATION / STEP)
    for i in range(n + 1):
        t = i * STEP
        for cam in cams:
            lines.append({
                "camera_id": cam, "capture_ts": ts(t), "ts_source": "receive", "source": "MOCK",
                "model_versions": {"detector": "mock-0"}, "quality": {"degraded": False},
                "ai_available": True, "frame_size": [1280, 720], "tracks": tracks(cam, t),
            })
    (HERE / "mock_observations.jsonl").write_text("".join(json.dumps(l) + "\n" for l in lines))
    pos = [
        {"id": "mock-pos-1", "register_id": "reg1", "type": "sale", "ts": ts(3), "amount_cents": 1850, "ticket_ref": "T-1040", "employee_ref": "E-17"},
        {"id": "mock-pos-2", "register_id": "reg1", "type": "no_sale", "ts": ts(5), "employee_ref": "E-17"},
        {"id": "mock-pos-3", "register_id": "reg1", "type": "refund", "ts": ts(30), "amount_cents": 4210, "ticket_ref": "T-1042", "employee_ref": "E-17"},
    ]
    (HERE / "mock_pos.jsonl").write_text("".join(json.dumps(p) + "\n" for p in pos))


if __name__ == "__main__":
    main()
