# AI Model Strategy

**Date:** 2026-11-20 · **Status:** Rules implemented and unit-tested on synthetic observations. **No rule or model has been validated on restaurant footage.** Thresholds are engineering starting points to be tuned in shadow mode.
Related: [API.md](../packages/contracts/API.md) · [SAFETY_VALIDATION](SAFETY_VALIDATION.md) · [LICENSING_REGISTER](LICENSING_REGISTER.md) · [RESEARCH_REPORT](RESEARCH_REPORT.md)

---

## 1. Principles

1. **Detectors observe, rules decide** (ADR-002). Models emit anonymous person tracks; every decision is an explicit, versioned rule in core (`rule_version` on each incident).
2. **No identity from video** (ADR-003). The worker sends `role: "person"`. "Staff" is a core inference from *where* a track is, never *who* it is. POS/time-clock IDs are the only identity source.
3. **Lost sight ⇒ INCONCLUSIVE, never "all clear".**
4. **Per-rule thresholds and per-rule opt-in alerting** (ADR-008). No global risk score.
5. **Licensing-safe stack** (ADR-004): no AGPL (Ultralytics, BoxMOT), no non-commercial weights in product.
6. **An incident is a prompt to review, not a finding.**

---

## 2. Event taxonomy (identical to API.md)

| event_type | family | Playbook use case | Trigger | Default policy |
|---|---|---|---|---|
| `after_hours_intrusion` | G | G1 | A person is detected outside the staff window (business hours, plus the pre-open and post-close allowances) | alert |
| `camera_tamper` | G | G3 | The camera is VIDEO_DEGRADED (black, obstructed or frozen) or CAMERA_UNAVAILABLE for 30 s or more | alert |
| `restricted_zone_entry` | D | D5 / G4 | A person not recognised as staff is in a `restricted` or `secure` zone for 3 s or more | review |
| `person_down` | F | F6 | A person's box stays lying-down shaped (real width/height ≥ 1.3, using `frame_size`) in a `floor` zone for 3 s or more. Only cameras with a `floor` zone are evaluated; overhead and 360° cameras must not have one | alert |
| `long_queue` | A | A4 | `max_people` (default 5) or more people in a `queue` zone for 60 s or more, during business hours | alert |
| `long_wait` | A | A4 | One person stays in a `queue` zone for 8 min or more | review |
| `unattended_post` | B | B4 | A `post` zone (register, host stand, counter) has nobody in it for 3 min or more, during business hours | alert |
| `pos_no_sale` | C | C1 | The POS reports a `no_sale` drawer open | review |
| `pos_refund_no_customer` | C | C3 | A POS `void`, `refund` or `comp` happens while nobody was in the register's `customer_side` zone between 20 s before and 5 s after it | alert |

Alert-policy rules start as **SHADOW**; `alerting_enabled: true` per rule in the site config turns real alerts on (audited at startup). Non-incident outputs: the **secure-zone access log** and **traffic counts** (§3.3).

---

## 3. Rule logic and thresholds

### 3.1 Track/zone rules
| Rule | Subjects | Logic | Thresholds (site-overridable) | Evidence gates |
|---|---|---|---|---|
| `after_hours_intrusion` | Any track (staff or not) | Track present while the clock is outside [open − `staff_before_open`, close + `staff_after_close`] in the site TZ | Schedule per weekday; Harbor Grill 90 min / 90 min | Camera FULLY_OPERATIONAL |
| `restricted_zone_entry` | Tracks **not** inferred staff | Position in a `restricted` or `secure` zone ≥ 3 s | 3 s | Camera healthy; staff tracks excluded |
| `person_down` | Any track | Real box w/h ≥ 1.3 (normalized box × `frame_size` aspect) continuously ≥ 3 s, box centre inside a `floor` zone. Cameras without a floor zone are never evaluated | 1.3, 3 s | Box confidence ≥ 0.4; healthy camera |
| `long_queue` | Tracks in `queue` zone | Count ≥ `max_people` continuously ≥ 60 s during business hours | 5 people, 60 s | Healthy camera |
| `long_wait` | One track in `queue` | Same track ID in zone ≥ `min_duration_s` | 480 s | Track continuity (see §5: ID switches) |
| `unattended_post` | Tracks in `post` zone | Zone empty ≥ `min_duration_s` during business hours | 180 s | Healthy camera (an unhealthy camera never produces "empty") |

### 3.2 POS rules
| Rule | Input | Logic | Notes |
|---|---|---|---|
| `pos_no_sale` | POSEvent `type=no_sale` | One incident per event; clip from the register's camera | Review policy: no-sales are often legitimate (making change) |
| `pos_refund_no_customer` | `void`, `refund`, `comp` | Look back 20 s and forward 5 s in the register's `customer_side` zone; if nobody, incident with `pos_ref` = `ticket_ref` | Needs POS clock within a few seconds of the edge clock ([ADR-010](architecture/adr/ADR-010-pos-integration.md)); the rule can decide only once observations up to +5 s exist |

POS events are deduped by `id`; events for unknown registers are ignored. `employee_ref` is stored for matching only.

### 3.3 Inference and aggregates
| Output | Logic | Known limits |
|---|---|---|
| **Staff inference** | `staff` if the track is on a `staff_only` camera, or has dwelt in a `staff_area` zone (threshold in core defaults) | Customers who step behind the counter become "staff" for that track; staff who never enter a staff_area on that camera stay "person" (§5) |
| **Access log** | Each visit (enter → leave) of a tracked person to a `secure` zone: camera, zone, role, start/end, `after_hours` | A track split by an ID switch becomes two visits |
| **Traffic** | `count_line` crossing direction → entry/exit; `peak_occupancy` = most people at once on that camera, per 15-min bucket | Crossings, not unique visitors; groups crossing together under-count when boxes merge |

---

## 4. Known failure modes

| Failure mode | Affects | Effect | Mitigation |
|---|---|---|---|
| **Track ID switches** (occlusion, crowd) | long_wait, access log, staff inference, counting | Wait timer resets (miss); a staff track becomes a new "person" (false `restricted_zone_entry`); double-counted crossings | ByteTrack tuning; staff inference sticky per zone; tune min durations in shadow |
| **Occlusion at busy counters** | pos_refund_no_customer, long_queue, unattended_post | Customer hidden behind another → "no customer" false positive; staff hidden → false "empty post" | Overhead register camera; customer_side zone sized generously; review policy until tuned |
| **360° fisheye distortion** | person_down, counting, zone membership | Upright people near the edge of a fisheye image appear wide/rotated → **box-aspect fall heuristic fires falsely**; boxes are poor fits | Dewarp or limit `floor` zones to the centre of fisheye images; prefer fixed cameras for counting |
| **Box-aspect fall heuristic** | person_down | **False positives:** someone crouching, kneeling to clean, sitting on the floor, children playing, a person lying on a booth bench, bending into a low fridge; overhead views (a top-down box carries no "lying" information). **False negatives:** a fall partly hidden by tables, a fallen person seen end-on | Draw `floor` zones on every camera (otherwise the rule applies to the whole image, e.g. the register overhead); keep SHADOW until tuned; pose-based check (RTMPose) is the planned upgrade |
| **Staff inference errors** | restricted_zone_entry, access log role | Delivery drivers, new hires, managers who don't stand behind the counter are "person"; a customer who reaches over the counter may become "staff" | Treat role as a hint; review policy; never used against a named person |
| **Lighting / night IR** | All | Missed detections after close (after-hours intrusion when lights are off) | Test with lights off in pilot; IR stratum in validation |
| **POS clock skew** | pos_refund_no_customer | Window misaligned → false "no customer" | NTP on POS/edge; skew check (roadmap) |
| **Reflections, screens, posters of people** | Detection | Phantom persons (after-hours false alerts) | Exclusion masks; shadow tuning |

---

## 5. Model stack

| Stage | In use | Licence (code / weights) | Notes |
|---|---|---|---|
| Person detector | **YOLOX-m Human-Art** (`yolox-m-humanart`, 640², ONNX); YOLOX-tiny Human-Art as a fast option | Apache-2.0 / COCO + Human-Art terms ⚠️ (open) | Pretrained public weights; not fine-tuned on restaurant CCTV |
| Tracker | **ByteTrack** | MIT | Per camera |
| Pose (optional) | **RTMPose-m/s Body7** via rtmlib | Apache-2.0 / Body7 mix ⚠️ (open) | Not used by any current rule; planned for a pose-based `person_down` and hand-to-pocket research |
| Runtime | ONNX Runtime (CPU/CUDA); TensorRT FP16 measured in the benchmark but **not yet used by the worker** | MIT / NVIDIA proprietary | See [BENCHMARK_RESULTS](BENCHMARK_RESULTS.md) |

Removed with the pivot: FiDIP, the infant/adult role classifier, held-state logic, InfAct-style posture modelling and breathing research.

---

## 6. Roadmap models

| Capability | Playbook | Approach (candidate) | Main risk | Licensing caveat |
|---|---|---|---|---|
| Fire / smoke | F7 | Fine-tuned detector on fire/smoke frames + temporal persistence; kitchen-specific negatives (steam, flambé, grill smoke) | Steam and cooking smoke are normal in kitchens → high FP | Many public fire/smoke checkpoints are Ultralytics-trained (**AGPL-3.0**); dataset terms vary — verify each |
| Weapon visible | F5 | Detector class for handgun/knife + persistence; kitchen knives excluded by zone | Kitchen knives, phones, tongs; rare positives | Same Ultralytics/AGPL caveat; staged-data rights |
| PPE / hairnet / gloves | B9 | Detector on kitchen crops (head covering, gloves) | Small objects; glove colour vs. skin | Check dataset terms; employee-relations review |
| Hand-to-pocket / cash handling | C5, C9 | Pose (wrist keypoints) near pocket + cash-zone context on 15 fps overhead | Very high FP; accusatory potential | Body7 weights terms ⚠️ |
| Object carry (bags/boxes) | D1 | Detector classes for bag/box at back door + direction | Trash runs and deliveries are normal | COCO has bag classes but no "box"; new labels needed |
| Fights / confrontation | F1–F4 | Skeleton action model (e.g. PoseC3D-style) on candidate windows | Busy-service motion; no audio by policy | Pretrained action weights trained on research-only data ❌ |
| Plates / pours | A8, D2, D4 | Counting at pass/bar | Occlusion, clutter | New labelled data |
| Natural-language search | H4 | VLM/embedding index over incidents, later clips (ADR-007) | Hallucination; privacy of an index | Apache-2.0 VLMs only (e.g. Qwen3-VL) |

**Every roadmap model ships in SHADOW and needs its own validation per [SAFETY_VALIDATION](SAFETY_VALIDATION.md).** Weights must be trained or fine-tuned on data we hold rights to before sale (OQ-L3).

---

## 7. Decision engine states

Per (camera, track or zone, event type): `OBSERVING → CANDIDATE → INCIDENT`, with `CANDIDATE → OBSERVING` if the condition clears before its duration, and `CANDIDATE → INCONCLUSIVE` if the camera goes unhealthy. Incidents then become `ALERTED` (alert policy, enabled), `SHADOW` (alert policy, not enabled) or `REVIEW_QUEUED`; lifecycle `new → acknowledged → resolved`. See [diagram 09](architecture/diagrams/09-decision-engine-states.md).

## 8. Versioning

Each incident stores `rule_version` and `model_versions`. A change to a rule's logic or default threshold bumps its version, so shadow statistics are never pooled across versions.
