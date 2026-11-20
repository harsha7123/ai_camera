# 06-network-security-boundaries

Source of truth: SYSTEM_ARCHITECTURE.md §9 (kept in sync).

```mermaid
flowchart TB
  subgraph CAMV["Camera VLAN (PoE)"]
    CAM["Cameras"]
    NVR[("NVR")]
  end
  subgraph POSV["POS VLAN"]
    POS["POS terminals / back office"]
  end
  subgraph EDGE["Edge appliance"]
    VW["vision-worker"]
    CONN["POS connector"]
    CORE["core :8080 public, 127.0.0.1:8090 internal"]
    PG[("Postgres, localhost")]
    EV[("Clip vault, encrypted")]
  end
  subgraph STAFF["Staff LAN"]
    PHONE["Manager phones / PCs"]
  end
  subgraph GUEST["Guest Wi-Fi"]
    G["Customer devices"]
  end
  subgraph NET["Internet"]
    RELAY["Webhook relay (push/SMS)"]
    CLOUD["Metadata plane (roadmap)"]
  end
  CAM -->|"RTSP 554, edge pulls"| VW
  POS -->|"vendor API or export"| CONN
  CONN -->|"NDJSON + bearer token, internal listener only"| CORE
  VW -->|"NDJSON + bearer token, loopback"| CORE
  CORE --> PG
  CORE --> EV
  PHONE -->|"HTTPS (TLS terminator in front of core)"| CORE
  CORE -->|"outbound only, no media"| RELAY
  CORE -.->|"outbound only, metadata"| CLOUD
  G -.-x|"blocked"| CAM
  G -.-x|"blocked"| POS
  CAM -.-x|"blocked: cameras to internet"| NET
  PHONE -.-x|"blocked: direct camera access"| CAM
```

Cameras, POS and guest Wi-Fi are three separate segments (playbook network advice). The POS connector reaches only core's internal listener.
