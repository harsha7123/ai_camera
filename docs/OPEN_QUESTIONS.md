# Open Questions

**Date:** 2026-11-20. Each item has a provisional assumption so work is not blocked.

## Business & scope
| ID | Question | Provisional assumption | Blocking? |
|---|---|---|---|
| OQ-B1 | Which site and state is the pilot? | One restaurant; state per owner (playbook names PA, WV, NJ properties) | Blocks pilot |
| OQ-B2 | QSR, full-service or bar first? | Full-service restaurant with 1–3 registers | No |
| OQ-B3 | Pricing (appliance + subscription?) | Subscription incl. appliance | No |
| OQ-B4 | Are hotel/store sites in scope later? | No; out of scope for this product | No |
| OQ-B5 | **Which POS (Toast, Square, Clover, other) and what API/partner access?** | One vendor first; local export as fallback | Blocks POS rules in the field |
| OQ-B6 | Which time clock (often part of the POS)? | Same vendor as POS | Blocks B1–B3 |

## Hardware & environment
| ID | Question | Assumption | Blocking? |
|---|---|---|---|
| OQ-H1 | Cameras/NVR at the pilot (make, codec, fisheye vs. fixed, overhead at registers?) | Existing 1080p PoE, one 360 dome, no register overhead yet | Blocks install |
| OQ-H2 | Can the network be split into camera / POS / guest VLANs? | Yes, with installer help | Blocks install |
| OQ-H4 | Edge GPU SKU and its decode limits | ≥ 8–16 GB discrete NVIDIA GPU; re-run benchmark on it | Blocks capacity claims |

## Legal & licensing
| ID | Question | Assumption |
|---|---|---|
| OQ-L1 | State-by-state notice wording (NY § 52-c reach to video, CT, DE) | Written notice + signed acknowledgment everywhere |
| OQ-L2 | Is anonymous person detection/tracking a "biometric identifier" anywhere we deploy? Pose keypoints? | No for boxes; keypoints treated as sensitive, not persisted |
| OQ-L3 | May we commercially use weights trained on COCO, Human-Art, Body7? | Uncertain; budget for fine-tuning on own data |
| OQ-L4 | TensorRT/DeepStream redistribution on an appliance | Permitted under NVIDIA terms, to confirm |
| OQ-L10 | PyAV wheels' FFmpeg build (LGPL-only?) | Ship our own LGPL build if needed |
| OQ-L11 | Union/CBA obligations at pilot sites | Ask before install |
| OQ-L12 | Retention period per state and litigation-hold scope for open matters | 30 days default; holds per counsel |
| OQ-L13 | PCI scope: does footage of payment areas bring the appliance into scope? | No card data in system; camera positioned to avoid PAN/PIN; confirm with QSA |
| OQ-L14 | CCPA/CPRA applicability (thresholds) for California sites | Provide notice regardless |

## Product
| ID | Question | Assumption |
|---|---|---|
| OQ-P1 | Which P1 rules does the owner want alerting first? | Tamper, after-hours, refund-without-customer |
| OQ-P2 | Live view wanted? | No (privacy liability); clips only |
| OQ-P3 | **How many false alerts per day will a manager tolerate (T)?** | 2 per site per day (used in SAFETY_VALIDATION §6) |
| OQ-P4 | Alert channels | Dashboard + phone push/SMS via relay |
| OQ-P5 | Escalation chain and ack timeout | 60 s to manager on duty, then owner |
| OQ-P6 | Review budget per shift for review-policy items | ≤ 10 |
| OQ-P7 | Clip length for POS exceptions (playbook 10–20 s) | Configure per rule |
| OQ-P8 | Should staff crossings be excluded from traffic counts? | Not yet; separate staff entrance where possible |
