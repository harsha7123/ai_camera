# 02-video-pipeline

Source of truth: SYSTEM_ARCHITECTURE.md §4 (kept in sync).

```mermaid
flowchart LR
  A["RTSP (TCP)"] --> B["Depacketize H.264/H.265"]
  B --> RB[("Ring buffer of encoded packets")]
  B --> C["Decode"]
  C --> D["Sampler: priority cams 15 fps, others 5 fps"]
  D --> Q{{"Bounded queue (drop-oldest, counted)"}}
  Q --> QC["Quality: black / frozen / obstructed"]
  Q --> DET["Person detector (YOLOX-m Human-Art)"]
  DET --> TR["ByteTrack per camera"]
  TR --> OB["Observation builder: tracks (role=person), boxes, quality, model versions"]
  QC --> OB
  OB -->|NDJSON| CORE["core event engine"]
```

`priority` cameras (register/POS overheads) are sampled at 15 fps, others at 5 fps. The worker never labels staff vs. customer and computes no face or body embeddings.
