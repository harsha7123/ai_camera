# Product Requirements: Zeoatap Restaurant Watchdog

**Date:** 2026-11-20 · **Contract:** [packages/contracts/API.md](../packages/contracts/API.md) (v2) · **Example site:** [services/core/site.example.json](../services/core/site.example.json) ("Harbor Grill")
**Sources:** the owner's *AI CCTV Watchdog Use-Case Playbook* (60 checks, families A–H) and the owner's industry-themes note. Related: [SYSTEM_ARCHITECTURE](SYSTEM_ARCHITECTURE.md) · [AI_MODEL_STRATEGY](AI_MODEL_STRATEGY.md) · [SAFETY_VALIDATION](SAFETY_VALIDATION.md) (accuracy & validation plan) · [FEATURE_ROADMAP](FEATURE_ROADMAP.md)

> **What it is.** An edge AI layer over a restaurant's **existing** CCTV for loss prevention, safety and operations. It ties what cameras see to POS events. It flags; **managers decide**. No alert is a finding about a person, and no discipline, police report or pay deduction may be based on an alert alone.
> **What is verified.** "Implemented" below means the code exists with automated tests on synthetic inputs. **No rule has been validated on real restaurant footage.** Every accuracy figure in these docs is an engineering goal, not a measurement.

---

## 1. Personas

| Persona | Role in API.md | Goals | Main screens | Constraints |
|---|---|---|---|---|
| **Owner** (1–3 sites) | `owner` | Less cash and food shrink, proof for chargebacks and claims, sees ROI | Overview, exception queue (incl. SHADOW), traffic, access log, legal hold | Decides which rules may alert (`alerting_enabled`). Accountable for notices and counsel sign-off |
| **GM / manager** | `manager` | Fewer surprises per shift; fast clip review; staffing to demand | Exception queue, clips, dispositions, traffic, access log | Reviews a clip before any action. Cannot see SHADOW incidents |
| **Shift lead / staff** | `staff` | Know when the line is long or a post is empty; acknowledge alerts | Overview, incident list, acknowledge | **No clip access** (staff are also the monitored population) |
| **IT / admin** (owner's IT or installer) | `admin` | Cameras, zones, users, audit integrity | Cameras, users, audit | **Cannot watch clips** (separation of duties). Sees SHADOW to support tuning |
| **Loss-prevention reviewer** (owner or delegated manager) | `owner` or `manager` | Pattern review across days: no-sales, refunds, access after hours | Exception queue filtered by type and `pos_ref` | Monthly LP review is roadmap (§5) |
| **Employees as monitored stakeholders** | — (not users) | Fair treatment; privacy in break areas; paid for all time worked | — | Posted notice + written acknowledgment; no face recognition; no monitoring of protected concerted activity (NLRA §7); see [PRIVACY_SECURITY_COMPLIANCE](PRIVACY_SECURITY_COMPLIANCE.md) |
| Customers (bystanders) | — | Not to be identified or tracked across visits | — | Notice at entrances; no biometrics; no re-identification |

---

## 2. User stories (MVP, with acceptance criteria)

| ID | Story | Acceptance criteria | Status |
|---|---|---|---|
| US-01 | As a **manager**, when a refund/void/comp happens with nobody at the counter, I get a clip to review | POS event ingested via `POST /internal/v1/pos-events`; `pos_refund_no_customer` if no person in the register's `customer_side` zone from −20 s to +5 s; incident carries `pos_ref`; clip from the register's camera | Implemented (rule + API); real POS connector not built |
| US-02 | As a **manager**, every no-sale drawer open lands in the exception queue with a clip | `pos_no_sale` (review policy) per `no_sale` event; deduped by POS event `id` | Implemented |
| US-03 | As an **owner**, I am alerted if anyone is inside after hours | `after_hours_intrusion` outside business hours ± staff allowance (`staff_before_open`/`staff_after_close`), in the site's IANA timezone | Implemented |
| US-04 | As a **manager**, I know when the counter line is long or a guest has waited too long | `long_queue` (≥ `max_people` for ≥ 60 s, business hours); `long_wait` (one person ≥ 8 min) | Implemented |
| US-05 | As a **shift lead**, I'm told when the register/host stand has been empty for 3 min while open | `unattended_post` (`min_duration_s`, default 180) | Implemented |
| US-06 | As an **owner**, I can see who (staff vs. not-staff, never a name) entered the safe, cooler or back door, and when | Access log `GET /api/v1/access-log`: one row per visit with `role`, start/end, `after_hours` | Implemented |
| US-07 | As a **manager**, I see a weekly busy map to plan staffing | `GET /api/v1/analytics/traffic`: 15-min buckets of entries/exits (from `count_line`) and peak occupancy | Implemented (API + heat map view) |
| US-08 | As an **owner**, I'm told if a camera is covered, moved or offline | `camera_tamper` after ≥ 30 s of VIDEO_DEGRADED or CAMERA_UNAVAILABLE; overview never shows green unless FULLY_OPERATIONAL | Implemented |
| US-09 | As a **manager**, a possible fall produces an immediate review prompt | `person_down` (box aspect heuristic ≥ 1.3 for ≥ 3 s in a `floor` zone) | Implemented, **heuristic, high false-positive risk** ([AI_MODEL_STRATEGY §4](AI_MODEL_STRATEGY.md)) |
| US-10 | As an **owner**, new alert rules stay silent until I've seen their shadow results | Alert-policy rules default to SHADOW; owner sets `alerting_enabled: true` per rule; each enabled rule audited at startup | Implemented |
| US-11 | As an **owner**, I can find the clip for a disputed ticket ("show me T-1042") | `GET /api/v1/incidents?pos_ref=T-1042` | Partial: only tickets that produced an incident |
| US-12 | As an **owner**, I can put an incident on legal hold so retention doesn't delete it | `POST /incidents/{id}/hold`; held clips skip retention deletion | Implemented |
| US-13 | As an **admin**, I can prove nobody altered the audit trail | `GET /api/v1/audit` returns `chain_ok`/`broken_at` | Implemented |
| US-14 | As a **manager**, I get a daily flash at 7 am | Visitors, conversion, peak hour, queue max, cash exceptions | **Roadmap** |
| US-15 | As a **payroll manager**, I see punch vs. on-camera hours | Needs time-clock integration (B1/B2) | **Roadmap** |

---

## 3. Use-case catalog (all 60 playbook checks)

**Zones** (playbook): SC store counter · HR hotel reception · **RR restaurant register/dining** · **KT kitchen** · ALL. **Pri** is the playbook's priority (P1 day one, P2 after tuning, P3 nice-to-have).
**Status:** **Implemented** (code + tests in this repo, not field-validated) · **Partial** · **Roadmap** · **Out of scope** (hotel/store-only, not RR/KT) · **Not planned** (policy reason given).

### A. Traffic & demand
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| A1 | Foot-traffic count | ALL | P1 | **Implemented** | Line crossings of a `count_line` zone → entries/exits per 15 min. Counts **crossings, not unique visitors** (no re-ID by design); staff using the same door are counted |
| A2 | Peak-hour heat map | ALL | P1 | **Implemented** | Peak occupancy per camera per 15-min bucket; dashboard day-of-week × time grid. Staffing *recommendation* is roadmap |
| A3 | Conversion (visitors ÷ POS tickets) | SC, RR | P1 | Roadmap | Both inputs exist (entries + POS `sale` events); report + drop-alert not built |
| A4 | Queue length & wait | SC, HR, RR | P1 | **Implemented** | `long_queue`, `long_wait` |
| A5 | Walk-outs / abandoned line | SC, HR, RR | P2 | Roadmap | Needs queue-zone exit without reaching counter, per track |
| A6 | Greeting / service speed | SC, HR | P2 | Out of scope | Store/hotel desk; drive-thru/counter speed (themes note) is covered by A4 for now |
| A7 | Repeat-visit frequency (appearance re-ID) | SC, RR | P3 | **Not planned** | Appearance re-ID across visits conflicts with ADR-003 posture |
| A8 | Kitchen ticket-to-pass time | KT, RR | P2 | Roadmap | Needs plate detection at pass + POS fire time |

### B. Workforce & time clock
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| B1 | Clock-in vs. on-camera arrival | ALL | P1 | Roadmap | Time-clock integration; match punch to first staff appearance at entrance **without face ID**. Payroll-accuracy tool (off-the-clock time must be paid) |
| B2 | Clock-out vs. departure | ALL | P1 | Roadmap | As B1 |
| B3 | Buddy punching | ALL | P1 | Roadmap | Time-clock camera: "a person present at the clock at punch time" vs. punch; **no badge-photo/face match** |
| B4 | Unattended post | SC, HR, RR | P1 | **Implemented** | `unattended_post` on `post` zones |
| B5 | Phone use on the floor | SC, HR, RR | P2 | Roadmap | Needs phone-in-hand model; employee-relations review before build |
| B6 | Idle-time profile | ALL | P2 | Roadmap (low) | Coaching only; NLRA and morale risk; aggregate, not per-person |
| B7 | Break compliance | ALL | P2 | Roadmap | Only from entry/exit of non-private areas; **break rooms are never monitored** |
| B8 | Staffing ratio | ALL | P1 | Roadmap | Staff vs. customer occupancy per hour; staff inference exists (§ AI_MODEL_STRATEGY) |
| B9 | Uniform & hygiene (hairnet, gloves) | KT | P2 | Roadmap | PPE model needed |
| B10 | Hand-wash compliance | KT | P2 | Roadmap | Station-visit after zone transition; restroom-exit trigger only from outside the restroom |

### C. Cash & POS theft (staff side)
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| C1 | No-sale drawer opens | SC, RR, HR | P1 | **Implemented** | `pos_no_sale` (review) + clip |
| C2 | Sweethearting | SC, RR | P1 | Roadmap | Needs item-handover vs. line-item comparison |
| C3 | Void/refund/comp with no customer | SC, RR | P1 | **Implemented** | `pos_refund_no_customer` |
| C4 | Under-ringing | SC, RR | P1 | Roadmap | Needs item counting + POS line items (POSEvent v2 has no line items) |
| C5 | Cash skimming (cash, no POS event) | SC, RR, HR | P1 | Roadmap | Needs hand-to-hand / cash detection |
| C6 | Hotel room-key rentals | HR | P1 | Out of scope | Hotel only |
| C7 | Discount & coupon abuse | SC, RR | P2 | Roadmap | POS `discount` events are already accepted; no rule yet |
| C8 | Till count & safe drops | ALL | P2 | Partial | Safe-zone access log; two-person/solo-count check is roadmap |
| C9 | Pocketing tips/change | SC, RR | P2 | Roadmap | Hand-to-pocket model; very high false-positive risk |

### D. Inventory & back-of-house shrink
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| D1 | Food walking out the back door | KT, SC | P1 | Partial | Back-door access log + after-hours intrusion; object-carry detection roadmap |
| D2 | Unrung food (plates vs. tickets) | KT, RR | P1 | Roadmap | Plate counting at pass |
| D3 | Over-portioning / waste | KT | P2 | Roadmap | Portion/trash models |
| D4 | Bar pour accuracy | RR | P2 | Roadmap | Pour counting vs. POS drinks |
| D5 | Walk-in cooler access | KT | P1 | **Implemented** | Access log + after-hours intrusion + `restricted_zone_entry` for non-staff |
| D6 | Delivery verification | KT, SC | P2 | Roadmap | Back-door access log gives times only; box counting roadmap |
| D7 | Hotel linen/supply theft | HR | P3 | Out of scope | Hotel only |

### E. Customer-side theft & fraud
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| E1 | Shoplifting / concealment | SC | P1 | Out of scope | Store only |
| E2 | Dine-and-dash | RR | P1 | Roadmap | Table occupancy + party exit + no payment on check (POS check↔table mapping) |
| E3 | Quick-change scams | SC, RR, HR | P2 | Roadmap | |
| E4 | Counterfeit-note hotspots | SC, RR | P3 | Not planned | Large-bill POS data not in contract; "clip for ID" implies identification |
| E5 | Refund fraud (never bought) | SC | P2 | Out of scope | Store returns |
| E6 | Hotel non-registered guests | HR | P2 | Out of scope | Hotel only |
| E7 | Chargeback defense | ALL | P1 | Partial | Incidents searchable by `pos_ref`; arbitrary-ticket clip retrieval needs continuous recording access (NVR) — roadmap |
| E8 | Loitering & casing | ALL | P2 | Roadmap | Dwell without transaction only; "repeat appearance" needs re-ID → not planned |

### F. Abuse, safety & conduct
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| F1 | Physical altercation | ALL | P1 | Roadmap | Fight/aggressive-motion model |
| F2 | Customer abuse of staff | SC, HR, RR | P1 | Roadmap | Confrontation model; **video only, no audio** |
| F3 | Staff mistreatment of customers | SC, HR, RR | P2 | Roadmap | Same model, HR-review route |
| F4 | Workplace harassment | ALL (not restrooms) | P1 | Roadmap | Owner-only confidential route; never break rooms/restrooms/locker areas |
| F5 | Weapon visible | ALL | P1 | Roadmap | Weapon model; no auto-911 without a monitoring-center contract |
| F6 | Slip / trip / fall | ALL | P1 | **Implemented (heuristic)** | `person_down` box-aspect rule; see failure modes |
| F7 | Kitchen safety: fire/smoke, wet floor | KT | P1 | Roadmap | Fire/smoke model; spills near fryers and blocked exits (themes note) later |
| F8 | Intoxicated / impaired person | ALL | P3 | Not planned | Health/impairment inference; high harm from false labels |
| F9 | Human-trafficking red flags | HR | P1 | Out of scope | Hotel only |

### G. After-hours, perimeter & system integrity
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| G1 | After-hours intrusion | ALL | P1 | **Implemented** | `after_hours_intrusion`; siren/talk-down not built |
| G2 | Opening/closing procedure | ALL | P2 | Roadmap | Nightly close report; two-person close check |
| G3 | Camera tampering | ALL | P1 | **Implemented** | `camera_tamper` |
| G4 | Safe access | ALL | P1 | **Implemented** | Access log + after-hours + `restricted_zone_entry` (non-staff in `secure`) |
| G5 | Parking lot / plates | HR, ALL | P3 | Not planned | LPR is personal data; no restaurant P1 need |

### H. Customer experience
| # | Use case | Zones | Pri | Status | How / what's missing |
|---|---|---|---|---|---|
| H1 | Cleanliness (tables, spills) | SC, RR, HR | P2 | Roadmap | Table-state/spill model |
| H2 | Lobby/reception standards | HR | P3 | Out of scope | Hotel only |
| H3 | Table turn time | RR | P2 | Roadmap | Table occupancy timers |
| H4 | Complaint investigation ("2:15 pm order at register 1") | ALL | P1 | Partial | `pos_ref` search over incidents; natural-language search roadmap (ADR-007) |

### 3.1 Status totals
| Status | Count | IDs |
|---|---|---|
| Implemented | 11 | A1 A2 A4 B4 C1 C3 D5 F6 G1 G3 G4 |
| Partial | 4 | C8 D1 E7 H4 |
| Roadmap | 33 | A3 A5 A8 B1 B2 B3 B5 B6 B7 B8 B9 B10 C2 C4 C5 C7 C9 D2 D3 D4 D6 E2 E3 E8 F1 F2 F3 F4 F5 F7 G2 H1 H3 |
| Out of scope (hotel/store-only) | 8 | A6 C6 D7 E1 E5 E6 F9 H2 |
| Not planned (policy) | 4 | A7 E4 F8 G5 |
| **Total** | **60** | |

---

## 4. Functional requirements (MVP, as built)

| ID | Requirement | Source |
|---|---|---|
| FR-01 | Ingest RTSP from existing cameras; per-camera state machine; worst-state roll-up per room and site | API.md "Monitoring states" |
| FR-02 | Nine event types exactly as API.md, each with policy `alert` or `review`; alert rules start SHADOW until `alerting_enabled` | API.md "Event types" |
| FR-03 | Staff/not-staff inference without biometrics: `staff_area` dwell or `staff_only` camera | Brief, ADR-003 |
| FR-04 | Business-hours schedule per weekday in the site timezone, with pre-open and post-close staff allowances | site.example.json |
| FR-05 | POS NDJSON ingest with `id` dedupe; unknown registers ignored | API.md internal endpoints, ADR-010 |
| FR-06 | Incident lifecycle new → acknowledged → resolved; dispositions `ok · coach · investigate · false_detection · escalated_external · inconclusive` | API.md |
| FR-07 | Encrypted clips (AES-256-GCM), 5-min clip tokens, first use of each token audited | API.md |
| FR-08 | Traffic analytics (≤ 92 days per query) and access log (≤ 1000 rows) | API.md |
| FR-09 | Alerts: SSE to dashboard + optional webhook (push/SMS relay) with retries, escalation if not acknowledged | API.md SSE |
| FR-10 | Retention deadline per incident; legal hold exempts | API.md |
| FR-11 | RBAC per API.md; admin cannot view clips | API.md |
| FR-12 | Hash-chained audit log, including clip views, dispositions, holds, rule enablement at startup | API.md |

---

## 5. Reports (playbook) and status

| Report | Frequency | Contents (playbook) | Status in this repo |
|---|---|---|---|
| Live alerts | Real time (push/SMS) | P1 events: violence, weapon, intrusion, no-sale/void with no customer, dine-and-dash, back-door carry-out, tampering, fall, fire | **Partial:** SSE + webhook for implemented rules (intrusion, void/refund with no customer, tamper, fall, queue, post). Push/SMS needs a relay behind the webhook (roadmap). Violence, weapon, dine-and-dash, carry-out, fire are roadmap models |
| Daily flash | 7 am | Visitors, conversion, peak hour, queue max, walk-outs, cash exceptions with clips, clock mismatches | Roadmap (inputs for visitors, peak hour and cash exceptions exist) |
| Shift exception queue | Per shift | Every flagged POS event with 10–20 s clip; manager marks OK / coach / investigate | **Implemented** as the incident inbox (dispositions include `ok`, `coach`, `investigate`). Clip length is configured in core, not fixed at 10–20 s |
| Weekly payroll reconciliation | Weekly | Punch vs. on-camera hours, buddy-punch hits | Roadmap (time-clock integration) |
| Weekly ops scorecard | Weekly | Busy map, staffing ratio, idle time, phone minutes, cleanliness, ticket times, table turns | Partial: busy map only (traffic heat map) |
| Monthly LP review | Monthly | Shrink trend, repeat patterns, cash variance vs. video exceptions | Roadmap. **Patterns "by employee" use POS `employee_ref`, never video identity** |

---

## 6. Dashboard design

Served by core as a static Next.js export. Phone-first for managers; desktop for owners/admins. Colour is never the only signal; **only FULLY_OPERATIONAL may be green**.

| Screen | Who | Content | API |
|---|---|---|---|
| **Overview** | all | Site state banner (worst room); open/closed with today's hours; rooms → cameras with state and "since"; `priority` badge on register cams; open-alert count; `alerts_health` (failed/delayed webhook deliveries); services (engine, database, evidence) | `GET /overview`, SSE `camera_state` |
| **Exception queue** (incident inbox) | all (SHADOW: owner/admin) | Newest first; filters open/all, event family, `pos_ref` search; SHADOW tab; badges ALERTED / REVIEW_QUEUED / SHADOW / INCONCLUSIVE; acknowledge | `GET /incidents`, SSE |
| **Incident detail** | all; clip: manager/owner | Neutral detail text ("refund $42.10 on register 1 with nobody at the counter"); POS ref; clip player (token), sha256; action history; disposition buttons (OK / Coach / Investigate / False detection / Escalated externally / Inconclusive) with note; legal hold toggle (owner/admin); fixed reminder: *"An alert is a prompt to review, not a finding."* | `GET /incidents/{id}`, `/ack`, `/disposition`, `/hold`, `/clips/{id}/token` |
| **Traffic heat map** | manager, owner | Day-of-week × 15-min grid of entries (or peak occupancy) for a chosen camera and date range; totals per day | `GET /analytics/traffic` |
| **Access log** | manager, owner | Table: zone (safe, cooler, back door), camera, role (`staff`/`person`), start–end, duration, after-hours flag; filter to after-hours | `GET /access-log` |
| **Admin: cameras** | admin | Camera list, zones, `priority`, `staff_only`, authorization record (who, when, scope) required to add | `GET/POST /cameras` |
| **Admin: users** | admin | Create, disable, change role/password (ends sessions) | `/users` |
| **Admin: audit** | admin | Entries with chain status; broken-chain banner with `broken_at` | `GET /audit` |

---

## 7. Non-functional requirements

| ID | Requirement | Target [goal unless noted] |
|---|---|---|
| NFR-01 | Detection → dashboard alert latency (rule confirmation to SSE) | p95 ≤ 5 s after the rule's own min-duration |
| NFR-02 | Offline operation | All detection, local alerting and review work with no internet (ADR-001) |
| NFR-03 | Honest health | Green only when FULLY_OPERATIONAL; camera stale > 3 s → not green |
| NFR-04 | Availability | Edge services restart automatically; `/readyz` reflects DB/engine health |
| NFR-05 | Capacity | Size per [COST_AND_DEPLOYMENT](COST_AND_DEPLOYMENT.md); `priority` cameras at 15 fps, others at 5 fps |
| NFR-06 | Privacy | Video stays on site; no audio; no face recognition or biometrics; no cameras in restrooms, changing/locker rooms |
| NFR-07 | Retention | Routine clip retention configurable 30–90 days; legal hold exempts |
| NFR-08 | Security | Session idle timeout 15 min; login throttling; CSRF via JSON content type + SameSite=Strict; clips encrypted at rest |
| NFR-09 | Auditability | Every clip view, disposition, hold, user change and enabled rule in a hash-chained log |
| NFR-10 | False-alert budget | Sum over enabled rules ≤ the manager's tolerance (see [SAFETY_VALIDATION §6](SAFETY_VALIDATION.md)) |
| NFR-11 | PCI scope | No card data accepted by the POS endpoint; register cameras must not capture full card numbers or PIN entry |
| NFR-12 | Usability | Manager reviews and dispositions a POS exception in ≤ 60 s on a phone [goal, measure in pilot] |
