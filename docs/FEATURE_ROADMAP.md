# Feature Roadmap

**Date:** 2026-11-20 · Follows the playbook rollout: **Pilot (30 days, P1 only) → Connect the data (days 30–60) → Tune & expand (days 60–90) → Prove ROI.** ✅ = done in this repository (code + automated tests on synthetic inputs; not field-validated). ☐ = not done.

## Phase 0: Platform and restaurant rules (this repository)
| Item | Status |
|---|---|
| Edge platform: RTSP ingest, health states, incidents, encrypted clips, SSE, RBAC (staff/manager/owner/admin), hash-chained audit, retention, legal hold | ✅ |
| Rules: after_hours_intrusion, camera_tamper, restricted_zone_entry, person_down (heuristic), long_queue, long_wait, unattended_post | ✅ |
| POS ingest endpoint + `pos_no_sale`, `pos_refund_no_customer`; dedupe by id; `pos_ref` search | ✅ |
| Staff inference (staff_area / staff_only), business-hours schedule | ✅ |
| Traffic counts + peak-hour heat map (A1/A2); secure-zone access log (D5/G4) | ✅ |
| SHADOW by default + per-rule `alerting_enabled`, audited at startup | ✅ |
| Webhook alert delivery with retries and escalation | ✅ |

## Phase 1: Pilot (days 0–30) — one site, P1 only
| Item | Status |
|---|---|
| Counsel review; posted notices; signed employee acknowledgments | ☐ |
| Site survey, VLANs, register overhead camera positioned for PCI | ☐ |
| Zones per camera (incl. `floor` on every camera that should run person_down) | ☐ |
| On-site staged tests (SAFETY_VALIDATION §7 phase 2) | ☐ |
| All alert rules in SHADOW; owner reviews daily | ☐ |
| Measure false-alert rate per rule and hours of footage review saved | ☐ |

## Phase 2: Connect the data (days 30–60)
| Item | Playbook | Status |
|---|---|---|
| First POS connector (one of Toast / Square / Clover) → `POST /internal/v1/pos-events` | C1, C3 | ☐ (endpoint ✅) |
| POS feed health + clock-skew check | — | ☐ |
| Time-clock integration; clock-in/out vs. arrival/departure | B1, B2 | ☐ |
| Buddy-punch check (person at clock vs. punch; no face ID) | B3 | ☐ |
| Conversion KPI (entries ÷ POS tickets) | A3 | ☐ |
| **Daily flash** (7 am): visitors, conversion, peak hour, queue max, cash exceptions | Reports | ☐ |
| **Weekly payroll reconciliation** (minutes both ways) | Reports | ☐ |

## Phase 3: Tune & expand (days 60–90)
| Item | Status |
|---|---|
| Per-rule enable decisions (SAFETY_VALIDATION §8) | ☐ (mechanism ✅) |
| Per-site thresholds | ☐ (config ✅) |
| **Mobile push/SMS** relay behind the webhook | ☐ |
| P2 rules in SHADOW: walk-outs A5, staffing ratio B8, discount abuse C7, till count C8, table turns H3 | ☐ |
| **Weekly ops scorecard** | ☐ |
| **Multi-site dashboard** (metadata plane, one view across locations) | ☐ |

## Phase 4: Prove ROI
Track before/after at the pilot site: cash variance, shrink %, food-cost %, payroll hours paid vs. verified, chargebacks won, incidents resolved by clip; plus review hours saved. ☐

## Phase 5: New models (each ships in SHADOW with its own validation)
| Item | Playbook | Status |
|---|---|---|
| Fire / smoke in kitchen | F7 | ☐ |
| PPE / hairnet / gloves; hand-wash visits | B9, B10 | ☐ |
| Dine-and-dash (table occupancy + party exit + unpaid check) | E2 | ☐ |
| Pose-based fall check (replace box heuristic) | F6 | ☐ |
| Back-door object carry | D1 | ☐ |
| Weapon visible | F5 | ☐ |
| Fights / confrontation | F1–F4 | ☐ |
| Natural-language search ("2:15 pm order at register 1") | H4 | ☐ (`pos_ref` search ✅) |
| Monthly loss-prevention review | Reports | ☐ |
| Plate/pour counting, ticket-to-pass | D2, D4, A8 | ☐ |

## Not planned
A7 repeat-visit re-ID, E4 counterfeit hotspots, F8 intoxication, G5 licence plates (see [PRODUCT_REQUIREMENTS §3](PRODUCT_REQUIREMENTS.md)). Hotel/store-only items are out of scope.
