# ADR-002: Detectors observe, rules decide, the alerter delivers, humans decide
**Status:** Accepted · **Date:** 2026-10-27, revised 2026-11-20

## Decision
- vision-worker emits `Observation`s: anonymous person tracks (`role: "person"`), boxes, quality, model versions. It makes no business decision and no staff/customer judgement.
- core's event engine applies explicit, versioned rules (`rule_version`) over tracks, zones, health, schedule and POS events.
- The alert dispatcher delivers (SSE, webhook), retries and escalates.
- **A manager decides**, using the clip. Incidents are review prompts, never findings about a person.

## Why
Deterministic replay and tests; auditability of which rule decided; model swaps without logic changes; per-rule opt-in alerting (ADR-008); a clear line for employment-law purposes between "the system flagged" and "a person decided".

## Consequences
Contract-first ([API.md](../../../packages/contracts/API.md), observation schema). Staff inference, business hours and POS correlation live in core, not in the model.
