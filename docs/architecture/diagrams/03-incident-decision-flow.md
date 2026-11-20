# 03-incident-decision-flow

Source of truth: SYSTEM_ARCHITECTURE.md §5 (kept in sync).

```mermaid
flowchart TD
  OBS["Observations (per camera)"] --> H{"Camera health<br/>fresh & not degraded?"}
  H -- no --> ST["Camera state change → SSE camera_state<br/>open candidates → INCONCLUSIVE"]
  ST --> TAMP{"Degraded/unavailable ≥ 30 s?"}
  TAMP -- yes --> I1["camera_tamper"]
  H -- yes --> ROLE["Staff inference per track<br/>(staff_only camera, or staff_area dwell)"]
  ROLE --> SCHED{"Business hours?<br/>(site TZ, ± staff allowance)"}
  SCHED --> TRK["Track/zone rules: after_hours_intrusion, restricted_zone_entry,<br/>person_down, long_queue, long_wait, unattended_post"]
  ROLE --> ACC["Access log: secure-zone visits"]
  OBS --> CNT["Traffic: count_line crossings, peak occupancy (15-min buckets)"]
  POSIN["POS events (deduped by id)"] --> POSR["POS rules: pos_no_sale,<br/>pos_refund_no_customer (customer_side −20 s…+5 s)"]
  TRK --> INC["Create or merge incident (idempotent key)"]
  POSR --> INC
  I1 --> INC
  INC --> POL{"Policy"}
  POL -- review --> RQ["REVIEW_QUEUED"]
  POL -- "alert, alerting_enabled=false" --> SH["SHADOW (owner/admin only)"]
  POL -- "alert, alerting_enabled=true" --> AL["ALERTED → SSE + webhook → escalation"]
  INC --> CLIP["Request clip(s) from vision-worker"]
```

POS path: a POS event for a known register (deduped by `id`) is evaluated by the POS rules against the register camera's `customer_side` zone; it shares incident creation, policy and clip capture with the video rules.
