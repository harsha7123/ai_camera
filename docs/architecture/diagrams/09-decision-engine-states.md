# 09-decision-engine-states

Source of truth: AI_MODEL_STRATEGY.md §7 and API.md (kept in sync).

```mermaid
stateDiagram-v2
  [*] --> OBSERVING
  OBSERVING --> CANDIDATE: rule condition true
  CANDIDATE --> OBSERVING: condition clears before min duration
  CANDIDATE --> INCONCLUSIVE: camera leaves FULLY_OPERATIONAL
  CANDIDATE --> INCIDENT: condition held for min duration
  INCIDENT --> MERGED: same room zone, type and overlapping window
  INCIDENT --> ALERTED: policy alert and alerting_enabled
  INCIDENT --> SHADOW: policy alert, alerting not enabled
  INCIDENT --> REVIEW_QUEUED: policy review
  ALERTED --> ESCALATED: not acknowledged within ack timeout
  ESCALATED --> ACKNOWLEDGED
  ALERTED --> ACKNOWLEDGED
  REVIEW_QUEUED --> ACKNOWLEDGED
  SHADOW --> RESOLVED: owner disposition
  ACKNOWLEDGED --> RESOLVED: manager disposition
  INCONCLUSIVE --> RESOLVED
  MERGED --> [*]
  RESOLVED --> [*]
```

POS rules enter at INCIDENT directly when the POS event's window has been evaluated. Dispositions: `ok`, `coach`, `investigate`, `false_detection`, `escalated_external`, `inconclusive`. Incident `status` values in the API are ALERTED, REVIEW_QUEUED, SHADOW and INCONCLUSIVE; `lifecycle` is new → acknowledged → resolved.
