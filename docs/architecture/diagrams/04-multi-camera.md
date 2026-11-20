# 04-multi-camera

Source of truth: SYSTEM_ARCHITECTURE.md §7 (kept in sync).

```mermaid
flowchart LR
  subgraph Counter["Room: Front counter"]
    C1["cam-counter: Register 1 overhead<br/>(priority, 15 fps)"]
    C2["cam-dining: Dining 360<br/>(sees the counter edge)"]
  end
  C1 --> T1["Tracks cam-counter (local ids)"]
  C2 --> T2["Tracks cam-dining (local ids)"]
  T1 --> Z["Zone projection: camera zones → room zones<br/>e.g. register-1-front, counter-queue"]
  T2 --> Z
  POS["POS event reg1 → room zone register-1"] --> CORR
  Z --> CORR["Correlator keyed by room zone + event type + time"]
  CORR --> DEDUP["Same room zone, same type, overlapping window<br/>= one incident, one clip per camera"]
  DEDUP --> INC[("Incident with clips from both cameras")]
```

No identity is carried between cameras: no face, no appearance embedding (ADR-003). Two tracks are never asserted to be the same person.
