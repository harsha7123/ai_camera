# Hurdle & Risk Register (restaurant)

**Date:** 2026-11-20. Obstacles between this repository and a restaurant product that owners trust, with how hard each is and the plan.
**Solvability:** 🟢 known engineering · 🟡 known approach, needs effort/data · 🟠 uncertain, research or negotiation · 🔴 may block a feature (fallback defined)

## 1. Vision and rules

| ID | Hurdle | Why it matters | Solv. | Plan |
|---|---|---|---|---|
| H-01 | **Busy-counter occlusion** | Customer hidden → false `pos_refund_no_customer`; staff hidden → false `unattended_post` | 🟡 | Overhead register camera; generous `customer_side` zone; shadow tuning; review policy until enabled |
| H-02 | **Staff/customer ambiguity** (no uniforms model, no identity) | Wrong role → false `restricted_zone_entry`, wrong access-log role | 🟡 | `staff_only` cameras, `staff_area` zones; role shown as a hint only; never used against a person |
| H-03 | Track ID switches in crowds | Wait timers reset; double counts; split access visits | 🟡 | Tracker tuning; conservative durations; count validation at the door |
| H-04 | **Fall heuristic false positives** (crouching, kneeling, sitting on floor, cleaning, children, fisheye) | Alert fatigue on a safety rule | 🟠 | `floor` zones on every camera; keep SHADOW; pose-based upgrade |
| H-05 | 360° fisheye distortion | Bad boxes at the image edge | 🟡 | Dewarp or restrict zones to the centre; fixed cameras for counting and registers |
| H-06 | Night/IR and lights-off after close | After-hours misses | 🟡 | Staged lights-off tests; IR stratum |
| H-07 | Roadmap models need restaurant data (fire/smoke vs. steam, weapons vs. kitchen knives, PPE, cash) | P1 playbook items blocked | 🟠 | Rights-cleared data collection at pilot sites (with notice); shadow first |
| H-08 | Weights provenance (Human-Art, Body7, COCO) | Licence risk on shipped weights | 🟠 | Counsel (OQ-L3); fine-tune on own data |

## 2. POS and integrations

| ID | Hurdle | Solv. | Plan |
|---|---|---|---|
| H-10 | **POS vendor API access** (Toast, Square, Clover partner programmes, rate limits, latency) | 🟠 | One vendor first (OQ-B5); fall back to the POS's local export or webhook if available |
| H-11 | **POS clock sync** (refund window −20 s … +5 s) | 🟢 | NTP on POS and edge; skew check (roadmap); widen window only with shadow evidence |
| H-12 | POS feed silently stops | 🟡 | Feed-health tile and alert when no events during open hours (roadmap) |
| H-13 | Line items missing from POSEvent v2 (C4 under-ringing, D2) | 🟡 | Contract change when needed |
| H-14 | Time-clock integration for B1–B3 | 🟡 | Vendor export first; match without face ID |
| H-15 | Card data leaking into the connector | 🟢 | No card fields in the contract; connector drops them; PCI review |

## 3. Video infrastructure

| ID | Hurdle | Solv. | Plan |
|---|---|---|---|
| H-20 | Mixed cameras/NVRs, RTSP quirks | 🟡 | Site survey; direct camera RTSP; NVR re-stream fallback |
| H-21 | Shared networks (cameras on guest Wi-Fi or POS VLAN) | 🟢 | VLAN setup in the install checklist |
| H-22 | Single edge box fails | 🟡 | Health visible on dashboard; spare-unit process; NVR keeps recording |
| H-23 | GPU driver/kernel version lock (seen in benchmark) | 🟢 | Pin kernel or DKMS driver |
| H-24 | Worker not yet on TensorRT/batching | 🟢 | Restaurant scale fits one GPU anyway; optimise later |

## 4. Legal, people and business

| ID | Hurdle | Solv. | Plan |
|---|---|---|---|
| H-40 | **Employee relations** (surveillance perception, morale, turnover) | 🟡 | Posted notice + written acknowledgment; "coaching, not discipline" framing; staff never see colleagues' clips; payroll reports pay owed time too |
| H-41 | **Union / NLRA §7** | 🟠 | No audio; no break-room cameras; no monitoring of gatherings; counsel review; bargaining where a union exists |
| H-42 | **False positives in the first 30–60 days** | 🟡 | All alert rules SHADOW; per-rule opt-in; summed false-alert budget |
| H-43 | **Liability** if a system flag leads to wrongful discipline or a missed incident | 🟠 | "AI flags, humans decide" in product and contracts; no claims beyond validated metrics; audit trail of human decisions |
| H-44 | **Insurance and slip-and-fall evidence** | 🟡 | Legal hold; clip sha256 + hash-chained audit; clips from original packets; NVR remains the full record |
| H-45 | **Retention vs. litigation holds** (routine deletion vs. duty to preserve) | 🟡 | Legal hold per incident; counsel decides scope; held clips never auto-deleted |
| H-46 | **Multi-state compliance** (wiretap, notice, biometrics, privacy, restroom statutes) | 🟠 | Strictest common defaults (no audio, no biometrics, written notice); per-state counsel checklist before each site |
| H-47 | PCI DSS around registers | 🟢 | Camera positioning/masking; no card data in system |
| H-48 | Alert channel: managers need phone push/SMS | 🟢 | Webhook exists; relay roadmap |
| H-49 | ROI hard to prove in 90 days | 🟡 | Baseline metrics before the pilot; playbook ROI list |

## 5. Top risks

1. H-42 alert fatigue → 2. H-40/H-41 employee relations & NLRA → 3. H-10 POS access → 4. H-04 fall heuristic → 5. H-46 multi-state law → 6. H-43 liability → 7. H-01 occlusion → 8. H-07 roadmap data → 9. H-08 weights provenance → 10. H-45 retention vs. holds.
