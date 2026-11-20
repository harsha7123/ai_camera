# Research Report: Restaurant & Retail Video Analytics

**Date:** 2026-11-20 (refocused from the 2026-10-27 infant-care report) · **Status:** Literature and licence notes. Nothing here is a validated performance claim for restaurant CCTV.
Sources and licences carried over from the earlier report were checked on 2026-10-27; new statements in this revision are general and marked **[to verify]** where a primary source has not been checked in this session.

Evidence labels: **[V]** verified from a primary source (2026-10-27) · **[R]** reported by authors, not reproduced · **[E]** our estimate · **[H]** hypothesis · **[to verify]** needs a source check before it is relied on.

---

## 0. Summary

1. **The most valuable restaurant checks are not deep-learning problems.** After-hours presence, camera health, zone dwell, queue length, empty posts and POS-event correlation are rules over person detection and tracking, which are mature [E]. The playbook's thesis — value comes from matching video with POS and time-clock records — points the same way.
2. **Person detection and tracking have a commercially usable open stack:** Apache-2.0/MIT detectors (YOLOX, RT-DETR, RF-DETR), trackers (ByteTrack, BoT-SORT) and pose (RTMPose/RTMO) [V]. **Ultralytics YOLO and BoxMOT are AGPL-3.0** [V], which matters because many community fire/smoke, PPE and weapon models are built on Ultralytics [to verify per model].
3. **Weights are the open licence question,** not code: COCO, Human-Art, Body7 and Objects365 training data have their own terms (OQ-L3).
4. **The hard restaurant items need new labelled data:** fire/smoke (kitchen steam is a confuser), weapons (rare, kitchen knives everywhere), PPE (small objects), cash/hand actions (high false-positive and accusation risk), plate/pour counting, fights. No public dataset matches restaurant CCTV with permissive terms that we have verified [to verify].
5. **Box-shape fall heuristics are weak** [E]: they confuse crouching, kneeling and sitting on the floor with falls, and fisheye distortion makes them worse. Pose- or sequence-based fall detection is the upgrade path, still needing restaurant validation.

---

## 1. Problem areas

| Area | Playbook | Typical approach (general) | What makes it hard in restaurants | Our status |
|---|---|---|---|---|
| **People counting** | A1 | Line crossing of tracked detections at a door; top-down cameras preferred [E] | Groups entering together; staff using the same door; doors at a steep angle | Implemented (crossings) |
| **Occupancy / peak hours** | A2, B8 | Count per time bucket | Occlusion in dense dining rooms; fisheye edges | Implemented (peak per 15 min) |
| **Queue analytics** | A4, A5 | Zone occupancy + per-track dwell | ID switches reset dwell; the queue spills outside the zone | Implemented (`long_queue`, `long_wait`) |
| **POS–video exception reporting** | C1–C9, E7 | Join POS events to clips by register and time; rules on events (no-sale, void, refund) with video context | POS clock skew; vendor API access; line items for under-ringing; hands occluded | Implemented for C1/C3 (POS connector not built) |
| **Fall detection** | F6 | Box aspect/height change; pose keypoint geometry; skeleton sequence classifiers [E] | Crouching/kneeling/cleaning, children, booths, fisheye; few real positives | Implemented as a heuristic only |
| **Fire / smoke** | F7 | Image detectors for flame/smoke + temporal persistence [E] | Steam, grill smoke and flambé are normal in kitchens; lighting changes | Roadmap |
| **PPE / hygiene** | B9, B10 | Detectors for head covering, gloves; station visits | Small objects; glove vs. skin colour; employee-relations sensitivity | Roadmap |
| **Weapon detection** | F5 | Object detectors for handguns/knives [E] | Kitchen knives, phones, tools; very rare positives; serious consequences of FPs | Roadmap |
| **Fights / confrontation** | F1–F4 | Skeleton or RGB action models on candidate windows | Busy-service motion; no audio by policy; public fight datasets are research-only | Roadmap |
| **Natural-language search** | H4 | VLM or embedding index over clips | Hallucination; an index of footage is itself personal data | Roadmap (ADR-007) |

---

## 2. Detection and tracking (commercial-safety check, from the 2026-10-27 review)

| Component | Licence [V] | Verdict |
|---|---|---|
| YOLOX | Apache-2.0 | ✅ In use (Human-Art-trained weights from MMPose; weights terms open) |
| RT-DETR (lyuwenyu) | Apache-2.0 | ✅ Candidate |
| RF-DETR (Roboflow) | Apache-2.0 (develop branch) | ✅ Candidate; check per-checkpoint terms |
| **Ultralytics YOLO** | **AGPL-3.0** | ⚠️ Only with a purchased enterprise licence |
| ByteTrack | MIT | ✅ In use |
| BoT-SORT | MIT | ✅ Alternative |
| **BoxMOT** | **AGPL-3.0** | ⚠️ Avoid |
| rtmlib (RTMPose/RTMO ONNX) | Apache-2.0 | ✅ Optional pose path |
| DWPose / ViTPose | Apache-2.0 | Alternatives / offline labelling |
| SAM 2 | Apache-2.0 | Annotation tooling only |

Reported results carried over [R]: RTMPose-m 75.8% COCO AP; RTMO-l 74.8% AP (arXiv:2303.07399, arXiv:2312.07526). Our own speed measurements are in [BENCHMARK_RESULTS](BENCHMARK_RESULTS.md).

**Weights provenance:** Apache-licensed code often ships weights trained on COCO (Flickr image terms; CC-BY 4.0 annotations), Objects365, Human-Art or Body7. Commercial use of those weights is a legal question (OQ-L3). The safe path is fine-tuning on restaurant footage we have rights to, with provenance recorded in [LICENSING_REGISTER](LICENSING_REGISTER.md).

---

## 3. Action recognition (for fights, cash handling)

| Model | Code licence [V] | Notes |
|---|---|---|
| PoseC3D (MMAction2) | Apache-2.0 | Skeleton-based; robust to pose noise [R]; candidate window classifier |
| SlowFast / X3D | Apache-2.0 | RGB; X3D is the lightweight option [R] |
| Video Swin | Apache-2.0 | Heavy; offline only |
| VideoMAE, Sapiens | **CC BY-NC 4.0** | ❌ Excluded |

Skeleton-first models fit privacy goals (pixels can be dropped after pose) but miss object context (cash, bags). Pretrained checkpoints are trained on Kinetics/NTU and similar data whose terms need review; public fight datasets (RWF-2000 and similar) require research agreements [R] and are not usable for the product.

**Maintenance risk [V, 2026-10-27]:** the OpenMMLab stack (MMAction2 1.2.0, MMPose 1.3.2) is effectively in maintenance mode. Train in a pinned environment, export ONNX, and run with ONNX Runtime/TensorRT.

---

## 4. Video anomaly detection

VadCLIP (Apache-2.0 code) reports 84.51% AP on XD-Violence and 88.02% AUC on UCF-Crime [R]; its released weights are trained on those research datasets. DSANet reports higher numbers but had no code [R/U]; CoReVAD has no licence file (all rights reserved) [V]. **Role for us:** at most an offline review prioritiser retrained on site-normal footage, never an alert trigger. "Unusual" is not "theft" or "danger".

---

## 5. Video-language models (for search and summaries)

| Model | Licence [V] | Notes |
|---|---|---|
| Qwen3-VL-2B/4B/8B-Instruct | Apache-2.0 | Primary candidate for local search/summaries |
| Qwen2.5-VL-7B | Apache-2.0 | Alternative |
| Qwen2.5-VL-3B | Qwen Research Licence | ❌ Excluded |
| InternVL3-8B, SmolVLM2-2.2B | Apache-2.0 | Alternatives |
| Phi-4-multimodal | MIT | Alternative (images) |

VLM latency is seconds and outputs are not calibrated [E]; never on the alert path (ADR-007).

---

## 6. Commercial landscape (as described in the owner's playbook; not independently verified)

| Vendor | Playbook description |
|---|---|
| Solink | Video + POS exceptions for restaurants, stores, multi-site; camera-agnostic; strongest for C/E use cases |
| Spot AI | Multi-site ops on existing cameras; plain-language search; "AI security guard / operations" agents |
| Coram AI | Safety + search on existing cameras; weapon and slip-and-fall alerts; natural-language alerts and search |
| Verkada / Rhombus | Own cameras with on-camera AI; Rhombus integrates POS partners (e.g. Glimpse) |
| Glimpse | Bar/restaurant pour and food theft with existing cameras + POS; spillage, theft, wait-time KPIs |

The owner's industry note adds three themes: zero hardware overhaul (edge AI on existing cameras), dual purpose (security + operations) and real-time notifications (mobile/SMS/local). Vendor capability claims are per vendor materials as of Oct 2026 and must be verified in demos.

---

## 7. Video infrastructure facts (from the 2026-10-27 review)

- DeepStream 8.0/9.0 are proprietary and tied to JetPack/CUDA/TensorRT versions [V: NVIDIA release notes]. TensorRT is proprietary (NVIDIA licence) [V].
- ONNX Runtime GPU 1.31.1 is MIT [V].
- In our benchmark, an unattended kernel upgrade unloaded the GPU driver (BENCHMARK_RESULTS, failure 1): pin kernels or use DKMS on appliances.

---

## 8. Decision matrix (restaurant)

| Capability | Approach | Priority | Data needed | Licence path | Confidence in approach |
|---|---|---|---|---|---|
| Health, after-hours, zones, queue, post | Detector + tracker + rules | **Done** | Site tuning only | ✅ code; weights OQ-L3 | High |
| POS exceptions (C1, C3) | POS events + zone presence | **Done** | POS feed | ✅ | High (rule); POS access open |
| Fall (F6) | Box heuristic → pose rule → sequence model | Heuristic done; upgrade P2 | Staged falls + hard negatives | ✅ code; Body7 weights ⚠️ | Low (heuristic) |
| Fire/smoke (F7) | Detector + persistence | Next model | Licensed fire/smoke + kitchen negatives | Verify dataset; avoid AGPL checkpoints | Medium |
| PPE (B9) | Detector on kitchen crops | Later | Labelled kitchen frames | Same | Medium |
| Weapon (F5) | Detector + persistence + zone exclusions | Later | Staged, rights-cleared | Same | Low–Medium |
| Cash/hand (C5, C9) | Pose + objects on 15 fps overhead | Research | Staged register footage | Body7 ⚠️ | Low |
| Fights (F1–F4) | Skeleton window classifier | Research | Staged, consented | Pretrained weights ❌ | Low |
| NL search (H4) | Local VLM / embeddings | Later | — | Apache-2.0 VLMs | Medium |

---

## 9. Research gaps

- No public restaurant-CCTV dataset with permissive terms that we have verified [to verify].
- No published evaluation of box-aspect fall heuristics on overhead or fisheye restaurant cameras that we have checked [to verify].
- Kitchen fire/smoke detection under steam and cooking smoke: evaluation evidence not reviewed [to verify].
- Cash-handling recognition from overhead register cameras: evidence not reviewed [to verify].

---

## 10. Sources (checked 2026-10-27 unless marked)

- RTMPose: https://arxiv.org/abs/2303.07399 ; RTMO: https://arxiv.org/abs/2312.07526
- PoseC3D: https://arxiv.org/abs/2104.13586 ; SlowFast: https://arxiv.org/abs/1812.03982 ; X3D: https://arxiv.org/abs/2004.04730 ; Video Swin: https://arxiv.org/abs/2106.13230
- MMAction2 / MMPose / MMDetection LICENSE (Apache-2.0): raw.githubusercontent.com/open-mmlab/*/main/LICENSE ; PyPI release dates: https://pypi.org/pypi/mmaction2/json
- VadCLIP: https://github.com/nwpu-zxr/VadCLIP ; DSANet: https://arxiv.org/abs/2511.10334 ; CoReVAD: https://arxiv.org/abs/2605.23116 , https://github.com/Muk-00/CoReVAD
- RWF-2000: https://arxiv.org/abs/1911.05913
- Qwen2.5-VL: https://arxiv.org/abs/2502.13923 ; Qwen3-VL: https://arxiv.org/abs/2511.21631 ; HF licence tags: https://huggingface.co/api/models/Qwen/Qwen3-VL-8B-Instruct
- Ultralytics AGPL: https://raw.githubusercontent.com/ultralytics/ultralytics/main/LICENSE ; BoxMOT AGPL: https://raw.githubusercontent.com/mikel-brostrom/boxmot/master/LICENSE
- DeepStream: https://docs.nvidia.com/metropolis/deepstream/8.0/text/DS_Release_notes.html ; https://docs.nvidia.com/metropolis/deepstream/9.0/text/DS_Release_notes.html
- BIPA commentary: https://www.insideprivacy.com/privacy-and-data-security/illinois-federal-court-dismisses-bipa-suit-against-x-holding-biometric-identifiers-must-identify-individuals/
- Owner documents: *AI CCTV Watchdog — Use-Case Playbook* (Oct 17, 2026) and industry-themes note (not public).
