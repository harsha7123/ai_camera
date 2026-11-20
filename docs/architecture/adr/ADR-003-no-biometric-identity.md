# ADR-003: No face recognition or biometric identity
**Status:** Accepted (strengthened 2026-11-20) · **Date:** 2026-10-27

## Context
The playbook warns that Illinois, Texas and Washington have biometric privacy laws "with real penalties". Illinois BIPA (740 ILCS 14) requires written notice, a written release and a retention policy before collecting face geometry and gives a private right of action; Texas (Bus. & Com. Code § 503.001) and Washington (RCW 19.375) regulate biometric identifiers too. Restaurant staff and customers are not in a position to give meaningful consent at the door. Buddy-punch detection (B3) and payroll reconciliation (B1/B2) are the obvious temptations to use face matching.

## Decision
- No face recognition, face/body embeddings, gait ID, voiceprints or appearance re-identification, in the worker or anywhere else.
- Track IDs are per camera and short-lived. Cross-camera association uses room zones and time only.
- "Staff" is inferred by core from location (`staff_area` dwell, `staff_only` cameras), never from appearance.
- Identity for POS and time-clock work comes only from those systems' own IDs (`employee_ref`). B3 will match "a person was at the clock at punch time" to the punch, not a face to a badge photo.

## Consequences
The system cannot say *who* is on video. Some playbook items (A7 repeat visits, E8 repeat casing, B3 badge-photo match) are not planned or are reduced. Any future proposal for identity requires counsel in each state, explicit written consent, a retention policy and a new ADR.
