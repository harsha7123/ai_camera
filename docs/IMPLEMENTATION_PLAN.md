# Implementation Plan

**Date:** 2026-11-20 · Phases match [FEATURE_ROADMAP](FEATURE_ROADMAP.md). Contract first: change [API.md](../packages/contracts/API.md) before code.

## Repository structure
```
packages/contracts/        API.md (v2) + observation.schema.json (v2)
services/core/             Go: event engine, POS rules, analytics, access log, API/SSE, alerts, evidence, audit
services/vision-worker/    Python: RTSP ingest, detector (YOLOX-m Human-Art), ByteTrack, quality, ring buffer, clip API
apps/web/                  Next.js dashboard (static export served by core)
tools/eval/                Event-level evaluation (Clopper–Pearson, Poisson, INSUFFICIENT_DATA)
tools/soak/                Multi-camera soak test
docs/                      This documentation
```

## Done (restaurant pivot, 2026-11)
| Area | Done |
|---|---|
| Contract | API v2: restaurant event taxonomy, roles, POS endpoint, traffic, access log |
| Engine | Nine rules; staff inference; business hours; count_line counting; access log; SHADOW + `alerting_enabled` |
| Worker | `priority` (15 fps) / normal (5 fps) sampling; `role: "person"` only; infant stack removed |
| Docs | Requirements, architecture, validation plan, privacy, ADR-009/010 |
| Test counts | See the top-level README (filled in by the lead) |

## Phase 1 tasks (pilot, days 0–30)
| # | Task | Acceptance |
|---|---|---|
| 1.1 | Install checklist: VLANs, camera authorization records, notices, acknowledgments | Signed checklist per site |
| 1.2 | Zone setup guide (incl. fisheye and `floor` zones) | Every enabled rule has a visible zone on the install snapshot |
| 1.3 | Staged on-site test script (tamper, after-close entries, falls on mats, no-customer refunds) | Results imported into tools/eval |
| 1.4 | Shadow-period dashboard stats per rule (count, dispositions, FA rate vs. budget) | Owner can read enable criteria in-app |
| 1.5 | TLS termination recipe + MFA for owner/admin | Security checklist items closed |

## Phase 2 tasks (days 30–60)
| # | Task | Acceptance |
|---|---|---|
| 2.1 | POS connector for the pilot's POS | Replays a day of POS data; dedupe and resend-from-`line` tested; no card fields |
| 2.2 | POS feed health + clock-skew monitor | Silent feed during open hours shown on overview |
| 2.3 | Time-clock import; B1/B2 report | Minutes listed both ways; no face matching |
| 2.4 | Conversion (A3) and daily flash | Scheduled at 7 am site time |
| 2.5 | Weekly payroll reconciliation | Reviewed by owner before payroll |

## Phase 3 tasks (days 60–90)
| # | Task | Acceptance |
|---|---|---|
| 3.1 | Push/SMS relay behind the webhook | No media in payload; delivery failures in `alerts_health` |
| 3.2 | P2 rules in SHADOW (A5, B8, C7, C8, H3) | Tests + shadow stats |
| 3.3 | Metadata plane + multi-site dashboard | Outbound-only; no video |
| 3.4 | TensorRT FP16 + batching in worker | Benchmark re-run on edge SKU |

## Next ten tasks (priority order)
1. POS connector for the pilot POS (2.1).
2. Shadow statistics per rule in the dashboard (1.4).
3. TLS termination + MFA (1.5).
4. Floor-zone guidance and a startup warning when `person_down` runs on a camera without a `floor` zone.
5. POS feed health + clock skew (2.2).
6. Install checklist and notice templates for counsel (1.1).
7. On-site staged test script → tools/eval (1.3).
8. Daily flash (2.4).
9. Push/SMS relay (3.1).
10. Fire/smoke data collection plan and licence review (Phase 5).
