# 07-failure-degraded-states

Source of truth: SYSTEM_ARCHITECTURE.md §8 and API.md "Monitoring states" (kept in sync).

```mermaid
stateDiagram-v2
  [*] --> NOT_CONNECTED
  NOT_CONNECTED --> FULLY_OPERATIONAL: observations arrive, quality ok
  FULLY_OPERATIONAL --> CAMERA_UNAVAILABLE: no observation for more than 3 s
  FULLY_OPERATIONAL --> AI_UNAVAILABLE: worker reports AI unavailable
  FULLY_OPERATIONAL --> VIDEO_DEGRADED: black, obstructed or frozen
  CAMERA_UNAVAILABLE --> FULLY_OPERATIONAL: stream restored
  AI_UNAVAILABLE --> FULLY_OPERATIONAL: detector back
  VIDEO_DEGRADED --> FULLY_OPERATIONAL: quality restored
  CAMERA_UNAVAILABLE --> TAMPER: 30 s or more
  VIDEO_DEGRADED --> TAMPER: 30 s or more
  TAMPER: camera_tamper incident
  TAMPER --> FULLY_OPERATIONAL: restored
```

Severity order (worst first): CAMERA_UNAVAILABLE > NOT_CONNECTED > AI_UNAVAILABLE > VIDEO_DEGRADED > FULLY_OPERATIONAL. Room = worst camera, site = worst room; only FULLY_OPERATIONAL is green. Open candidates on a camera that leaves FULLY_OPERATIONAL end INCONCLUSIVE. Service-level problems (database, engine, evidence, webhook delivery, silent POS feed) are shown separately in the overview's `services` and `alerts_health`.
