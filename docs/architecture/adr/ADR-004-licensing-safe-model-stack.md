# ADR-004: Licensing-safe model stack
**Status:** Accepted · **Date:** 2026-10-27, revised 2026-11-20

## Decision
Ship only code under Apache-2.0/MIT/BSD (or commercially licensed runtimes such as TensorRT), with weights whose training-data terms permit commercial use or that we fine-tune on data we hold rights to. Exclude AGPL (Ultralytics, BoxMOT), CC BY-NC (VideoMAE, Sapiens), research-only licences and unlicensed code.

## Change on 2026-11-20
The restaurant pivot removed FiDIP, InfAct, AIR-400 and the ACLab datasets (SyRIP and others). The product stack (YOLOX Human-Art detector, ByteTrack, optional RTMPose) is now consistent with this ADR at the **code** level. Open items remain at the **weights/data** level (Human-Art, Body7, COCO; OQ-L3) and for runtimes (TensorRT redistribution OQ-L4, PyAV's FFmpeg build OQ-L10). See [LICENSING_REGISTER](../../LICENSING_REGISTER.md).

## Consequences
Roadmap models (fire/smoke, weapon, PPE) cannot simply adopt popular Ultralytics-trained checkpoints; each needs a licence row before use.
