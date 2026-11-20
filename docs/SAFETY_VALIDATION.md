# Accuracy & Validation Plan

*(File name kept as `SAFETY_VALIDATION.md` for link stability.)*

**Date:** 2026-11-20 · **Status:** Plan defined. **No validation has been executed on restaurant footage or POS data.** Every number below is a pre-registration proposal or an engineering goal, not a result.
Tooling: [`tools/eval`](../tools/eval/) (event-level matching, exact Clopper–Pearson and Poisson intervals, `INSUFFICIENT_DATA` refusal). Its goal and ground-truth files must use the `event_type` names in [API.md](../packages/contracts/API.md).

---

## 1. Principles

- **Event level, per rule.** A 10-minute queue is one event, not 3,000 frames. Frame metrics are diagnostic only.
- **Pre-register** each rule's goal, sample size and enable criteria before looking at results.
- **Confidence bounds, not point estimates.** A rule "passes" when the 95% lower bound on recall (or upper bound on false alerts) meets the goal.
- **Shadow first.** Alert-policy rules run as SHADOW for 30–60 days at each pilot site; only the owner enables alerting, per rule (ADR-008).
- **AI flags, humans decide.** Validation measures whether alerts are *worth reviewing*, never whether a person did something.

---

## 2. Event definitions (annotation contract)

| event_type | Ground-truth start | Ground-truth end | Exclusions |
|---|---|---|---|
| `after_hours_intrusion` | First frame a person is visible outside the staff window | Person leaves view | Authorised late staff are still positives (the rule cannot know authorisation); label `authorised` for analysis |
| `camera_tamper` | Fault injected / view lost | View restored | Scheduled maintenance windows |
| `restricted_zone_entry` | Non-staff person enters zone | Leaves | Staff (by annotator knowledge of uniforms/roster, used for labels only) |
| `person_down` | Person reaches the floor | Person stands up | Deliberate sitting, kneeling, crouching, cleaning, children playing → **hard negatives** |
| `long_queue` | Queue reaches `max_people` | Drops below | — |
| `long_wait` | Person joins queue | Served or leaves | — |
| `unattended_post` | Last staff leaves post zone | Staff returns | Closed hours |
| `pos_no_sale` | POS `no_sale` timestamp | — | — |
| `pos_refund_no_customer` | POS void/refund/comp timestamp with no customer at the counter (−20 s … +5 s) | — | Annotator labels customer presence for **every** void/refund/comp, not only flagged ones |

---

## 3. Metrics

| Metric | Definition |
|---|---|
| Event recall | GT events matched by ≥ 1 incident of the same type ÷ GT events (matching as in tools/eval: overlap or start within [GT.start − 1 s, GT.end + latency budget]; one-to-one Hungarian) |
| Precision (shadow) | Incidents dispositioned as true (`ok`, `coach`, `investigate`, `escalated_external`) ÷ incidents dispositioned conclusively. `false_detection` = FP. `inconclusive` reported separately, excluded from both |
| False alerts / exposure unit | Unmatched alert-policy incidents (ALERTED or SHADOW) ÷ exposure (camera-hours in FULLY_OPERATIONAL, or POS events for POS rules) |
| Duplicates | Extra incidents on one GT event (alert fatigue) |
| Latency | `created_at − GT.start` beyond the rule's own minimum duration (p50, p95) |
| Health honesty | Any time green was shown while not FULLY_OPERATIONAL (must be zero) |
| Reconciliation (POS) | POS `no_sale` events for known registers vs. `pos_no_sale` incidents (must match exactly) |
| Review effort | Manager minutes per shift on the exception queue; hours of footage review saved (playbook pilot metric) |

---

## 4. Statistics (consistent with tools/eval)

**Recall with zero misses.** Exact 95% Clopper–Pearson. For n/n detected, the two-sided lower bound is `0.025^(1/n)`, the one-sided `0.05^(1/n)`; the rule of three approximates the one-sided bound as `1 − 3/n`.

| Recall goal (lower bound) | n, two-sided (default) | n, one-sided | n, rule of three |
|---|---|---|---|
| 0.80 | 17 | 14 | 15 |
| 0.90 | 36 | 29 | 30 |
| 0.95 | 72 | 59 | 60 |
| **0.99** | **368** | 299 | **300** |

- **n = 100 with zero misses does not support 0.99**: its lower bound is 0.964 (two-sided) or 0.970 (one-sided). Never state that n ≥ 100 suffices for a 99% claim.
- Any miss raises the required n. tools/eval returns `INSUFFICIENT_DATA` (never PASS) below the required n.

**False-alert rates with zero observed.** Exact Poisson: the two-sided 95% upper bound for 0 events in exposure E is 3.69/E (one-sided 3.00/E). To show a rate ≤ r you need **E ≥ 3.69/r**. For proportions (POS rules), 0 FPs in n events bounds the FP fraction at `1 − 0.025^(1/n)`.

---

## 5. Proposed per-rule goals (pilot, pre-registration draft)

| Rule | Policy | Recall goal (95% LB) → staged/labelled n | FA goal | Exposure to show FA goal with 0 FAs | Latency p95 |
|---|---|---|---|---|---|
| `camera_tamper` | alert | 0.95 → 72 injected faults (unplug, cover, turn, black) | 0.002 / cam-h | 1,845 cam-h | ≤ 40 s (30 s rule + 10 s) |
| `after_hours_intrusion` | alert | 0.90 → 36 staged after-close entries, lights on and off | 0.004 / closed cam-h | 922 cam-h | ≤ 10 s |
| `person_down` | alert | 0.90 → 36 staged falls (consenting staff, mats) + hard negatives (crouch, kneel, sit on floor, mop) | 0.005 / occupied cam-h | 738 cam-h | ≤ 10 s |
| `long_queue` | alert | 0.90 → 36 labelled episodes | 0.02 / open queue-cam-h | 185 cam-h | ≤ 15 s |
| `unattended_post` | alert | 0.90 → 36 labelled episodes | 0.02 / open post-cam-h | 185 cam-h | ≤ 15 s |
| `pos_refund_no_customer` | alert | 0.90 → 36 staged no-customer refunds | FP fraction ≤ 0.02 of void/refund/comp events | 183 events | ≤ 10 s after POS event arrives |
| `restricted_zone_entry` | review | 0.80 → 17 staged entries by non-staff | Review budget (§6) | — | ≤ 10 s |
| `long_wait` | review | 0.80 → 17 labelled waits | Review budget | — | ≤ 15 s |
| `pos_no_sale` | review | **Exact reconciliation** (deterministic) | — | — | ≤ 10 s |

These goals are proposals for the owner and the pilot site to confirm before the shadow period starts.

---

## 6. False-alert budget (summed across rules)

A manager tolerates a **total** number of false pages per day, not one per rule. The budget is `Σ_rules (FA rate × daily exposure) ≤ T`, where T is the manager's tolerance (assumed **2 false alerts/site/day**, OQ-P3 to confirm). Worked example, Harbor Grill on a Monday (open 11:00–22:00 = 11 h; staff window 09:30–23:30 = 14 h; closed 10 h; 5 cameras; 1 queue zone, 1 post zone; assumed 15 void/refund/comp per day [E]):

| Rule (alert policy) | Exposure/day | FA goal | Expected false alerts/day |
|---|---|---|---|
| after_hours_intrusion | 5 cams × 10 h = 50 cam-h | 0.004 | 0.20 |
| camera_tamper | 5 × 24 h = 120 cam-h | 0.002 | 0.24 |
| person_down | 5 × 14 h = 70 cam-h | 0.005 | 0.35 |
| long_queue | 1 × 11 h = 11 cam-h | 0.02 | 0.22 |
| unattended_post | 1 × 11 h = 11 cam-h | 0.02 | 0.22 |
| pos_refund_no_customer | 15 events | 0.02 | 0.30 |
| **Total** | | | **1.53 ≤ T = 2** (0.47 headroom) |

At exposure/day as above, showing each FA goal with zero false alerts takes: tamper 1,845/120 ≈ 15 days; after-hours 922/50 ≈ 18 days; person_down 738/70 ≈ 11 days; queue and post 185/11 ≈ 17 days; refunds 183/15 ≈ 12 days. **Any observed false alert extends this**, which is why the shadow period is 30–60 days and not shorter. If one rule overspends, either tune it, move it to `review`, or keep it in SHADOW; do not raise T silently. Review-policy rules do not page, but their volume is capped by a separate review budget (proposed ≤ 10 items per shift, to confirm with managers).

---

## 7. Phases

| Phase | What | Exit criteria |
|---|---|---|
| 1. Offline replay | Recorded or staged clips + POS logs → worker → core replay → tools/eval | Deterministic (same input → same incidents); no crashes |
| 2. On-site staged tests | During setup week: fault injection, after-close walk-ins, staged falls on mats, staged no-customer refunds | Recall bounds in §5 or documented shortfall |
| 3. **Shadow (30–60 days)** | All alert rules SHADOW; owner reviews and dispositions; labels every void/refund/comp for customer presence; weekly spot audit of random footage hours for misses | Per-rule enable criteria (§8) |
| 4. Per-rule enable | Owner sets `alerting_enabled: true` for passing rules only; audited at startup | Stop conditions never triggered |
| 5. Expand | Add P2 rules (shadow again), more sites | Per-site metrics within goal |

## 8. Per-rule enable criteria (all must hold)

- [ ] Rule's camera coverage verified (zones drawn, `floor` zones on every camera where `person_down` should run)
- [ ] Shadow period ≥ 30 days **and** exposure ≥ the §5 requirement for the rule's FA goal
- [ ] FA upper bound ≤ goal; the site's summed budget (§6) still ≤ T with this rule added
- [ ] Recall lower bound ≥ goal from staged tests, or the owner accepts a documented lower claim
- [ ] Precision from dispositions reported with its interval
- [ ] No health-honesty violations; failure-injection suite passes ([TESTING_STRATEGY](TESTING_STRATEGY.md))
- [ ] Employee notice/acknowledgment in place for the monitored area ([PRIVACY_SECURITY_COMPLIANCE](PRIVACY_SECURITY_COMPLIANCE.md))

## 9. Stop conditions (pilot)

- Green shown while a camera was not analysing.
- False alerts > 3× the site budget T for 3 consecutive days → affected rules back to SHADOW.
- Any unauthorised clip access, or a clip seen by a role that should not see it.
- Any adverse action (discipline, pay deduction, police report) taken on an alert **without** a manager's clip review → pause and retrain managers.
- Monitoring of a protected area (break room, restroom, locker area) discovered → camera disabled immediately.

## 10. Rollback

Set the rule's `alerting_enabled` to false (or policy to `review`) and restart core; the change is audited. Incidents raised under the bad rule version are flagged for re-review by `rule_version`.
