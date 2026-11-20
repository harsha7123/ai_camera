# 05-data-retention-lifecycle

Source of truth: SYSTEM_ARCHITECTURE.md §6 and PRIVACY_SECURITY_COMPLIANCE.md §5 (kept in sync).

```mermaid
flowchart LR
  F["Decoded frames"] -->|"RAM only, milliseconds"| X1(("discarded"))
  RB["Ring buffer: encoded packets"] -->|"RAM, rolling"| X2(("overwritten"))
  RB -->|"on incident"| SPOOL["Plaintext clip in spool"]
  SPOOL -->|"core encrypts AES-256-GCM, deletes plaintext"| VAULT[("Clip vault")]
  OBS["Observations: tracks, boxes"] -->|"RAM"| ENG["Event engine"]
  ENG --> AGG[("traffic_counts: 15-min aggregates")]
  ENG --> ACC[("zone_access: secure-zone visits")]
  ENG --> INC[("incidents + actions")]
  POS["POS events (no card data)"] --> PE[("pos_events")]
  VAULT -->|"retention_deadline: 30-90 days"| DEL["Deleted; media returns 410"]
  VAULT -->|"legal hold by owner/admin"| HOLD["Kept until released"]
  INC --> AUD[("audit_log: hash-chained")]
  NVR[("Existing NVR")] -.->|"its own policy, not ours"| NVRP["Facility retention"]
```

Never stored: audio, face or body embeddings, biometric templates, card numbers or PINs.
