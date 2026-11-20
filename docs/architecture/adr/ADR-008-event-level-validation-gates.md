# ADR-008: Alerting is opt-in per rule after shadow tuning
**Status:** Accepted (rewritten 2026-11-20) · **Date:** 2026-10-27

## Context
The playbook expects false positives for the first 30–60 days and requires that "AI flags, humans decide". The earlier design gated alerts on a signed validation report per release; that is heavy for a single restaurant and puts the decision with the vendor rather than the site owner who bears the alert burden.

## Decision
- Every `alert`-policy rule produces **SHADOW** incidents until the site config sets `"alerting_enabled": true` for that rule. SHADOW incidents are visible only to owners and admins and page nobody.
- `review`-policy rules go to the exception queue and never page.
- core writes **every enabled rule to the audit log at startup**, so who turned what on, and when, is provable.
- The owner enables a rule after the 30–60 day shadow period, using the per-rule criteria in [SAFETY_VALIDATION §8](../../SAFETY_VALIDATION.md) (exposure, false-alert bound, the site's summed budget).

## Replaces
The `validated_for_alerting` flag set by a signed validation report.

## Consequences
+ The person who receives the alerts decides when they are worth receiving; the decision is audited.
− A careless owner can enable an untuned rule; mitigated by the audit entry, the dashboard's SHADOW statistics and the pilot stop conditions. Validation evidence is still produced (tools/eval) but is advisory, not a code gate.
