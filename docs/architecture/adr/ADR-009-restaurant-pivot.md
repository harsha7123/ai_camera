# ADR-009: Pivot to restaurant loss prevention, safety and operations
**Status:** Accepted · **Date:** 2026-11-20

## Context
The repository was built as an infant-care CCTV safety platform. The owner's *AI CCTV Watchdog Use-Case Playbook* (60 checks, families A–H) and industry-themes note redirect it to restaurants (register/dining "RR" and kitchen "KT"): theft by staff and customers, safety, and operations, on existing cameras, tied to POS and time-clock data. The playbook's thesis: "the biggest money is not in the camera — it is in the data match: video + transaction + punch time."
The infant stack carried unresolved non-commercial licences (FiDIP, ACLab data), no ethical source of positive examples, and medical-device-adjacent risk.

## Decision
- Product becomes **Zeoatap Restaurant Watchdog**; API contract v2.
- Keep the platform: edge appliance, health states, incidents, clips, RBAC, audit, retention, SSE, eval tooling.
- Remove the infant model stack and taxonomy; add restaurant rules (after-hours, tamper, restricted/secure zones, person down, queue, wait, unattended post, POS no-sale and refund-without-customer), staff inference without biometrics, business hours, traffic counting and a secure-zone access log.
- POS becomes a first-class input (ADR-010). Roles become staff / manager / owner / admin.
- Pilot rollout per playbook: one site, P1 rules in shadow for 30 days, then POS/time clock, then tuning and expansion.

## Consequences
+ Clearer buyer and ROI metrics (cash variance, shrink %, food-cost %, payroll hours, chargebacks, incidents resolved by clip); simpler licensing.
− New legal surface: employee monitoring (NLRA, notice laws, wage-and-hour), PCI DSS around registers, audio wiretap laws; several playbook P1 items need new models (fire/smoke, weapon, fights, dine-and-dash) or integrations (time clock).
− Hotel and store-only use cases are out of scope.
