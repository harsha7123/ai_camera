# Models and packages used by the vision-worker

This file lists what the person pipeline (`--detector person`, and `--detector pose` with the optional pose model) downloads and runs, with sources, licenses and hashes, so the licenses can be cleared before product use (see [LICENSING_REGISTER](../../docs/LICENSING_REGISTER.md)).

> **Every model here is a public pretrained model. None is trained or validated on restaurant CCTV** (overhead register views, kitchens, low light, crowds at the counter). The pipeline output is labelled that way (`model_versions.validation = "UNVALIDATED-…"`). Accuracy for queue counts, dwell times, zone presence and the `person_down` box-shape rule is unknown until measured on site footage.

Weights are not in git (`services/vision-worker/models/` is git-ignored). `scripts/fetch_models.py` checks the sha256 of each archive and each extracted ONNX against the values pinned in `src/zeoatap_vision/models.py`. The worker checks the ONNX hash again before it loads a model.

## License status (to clear before sale)
- **Code** of every model below is Apache-2.0 (OpenMMLab mmpose/mmdetection, Megvii YOLOX, rtmlib).
- **YOLOX Human-Art weights (the default detector):** trained on COCO plus **Human-Art** (IDEA-Research). Human-Art's dataset terms, and whether they reach weights trained on it, have not been checked for commercial use. COCO images carry Flickr licenses of their own. Tracked as OQ-L3 in the licensing register. If the terms do not allow commercial use, the fallback is a COCO-only person detector with clear terms (e.g. YOLOX from Megvii's own release, as used in `benchmark/`), re-pinned here.
- **RTMPose Body7 weights (optional, `--detector pose` only):** trained on seven datasets, some with non-commercial terms. Pose is not required by any rule today, so `--detector person` avoids these weights entirely.

## Models

| Model (registry name) | Role | Code license | Weights / training data | Source | Archive sha256 | ONNX sha256 |
|---|---|---|---|---|---|---|
| `yolox-m-humanart` (default) | person detector, 640×640, NMS in the graph | Apache-2.0 (open-mmlab/mmpose, mmdetection; Megvii YOLOX) | COCO + **Human-Art** (IDEA-Research). Human-Art's dataset terms need a separate check. | https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip (mirror: huggingface.co/Tau-J/RTMPose) | `a000224fd8ba283202bc62d4a5fcdfe353adb9f468777dbac1ea2ada2093adde` | `3dea6513388889f0fff4b77bf7a26013600321b9eb9ceb0e9a400a82572f5f23` |
| `yolox-tiny-humanart` | person detector, 416×416 (faster, misses small or far people) | Apache-2.0 | same as above | …/onnx_sdk/yolox_tiny_8xb8-300e_humanart-6f3252f9.zip | `36e09ca555916253fa1b5d51bec01e48e98e1f0af966c51ce3e844d8c8fc4cfc` | `ceb11c07298f95c50d7c5abeb906d03340c85f23aa79e3e66966e7fb6c307250` |
| `rtmpose-m-body7` (default for `--detector pose`) | optional top-down pose (fills `pose_quality`/`visibility` only), 17 COCO keypoints, 256×192 | Apache-2.0 (open-mmlab/mmpose) | **Body7**: COCO, AI Challenger, CrowdPose, MPII, sub-JHMDB, Halpe, PoseTrack18. Each dataset has its own terms, some non-commercial. | …/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip | `f7fbb6c5c11a1bb70f3d445e4ddec5d144ea89ad5649c081ef976f9b24a0b741` | `5c0a4bf67953e6d2ac43ce15e77dc9d5d354ae18430a47d2c5963a7bc5683e3c` |
| `rtmpose-s-body7` | top-down pose, 256×192 (faster) | Apache-2.0 | Body7 (as above) | …/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip | `7673922e531014906ca4f0f239b7e233b740146a10b632deaa2a28d45470d802` | `9aeb635b83f86aea45cf45d85798f7eba1a162de8e0d721c44e54fe5eebaf47d` |

## Test media

| File | Content | License | Source | sha256 |
|---|---|---|---|---|
| `models/test_adults_nasa_crew1.jpg` | still photo of **adults**: the SpaceX Crew-1 walkout, 4 astronauts and staff | NASA media, public domain in the US. Identifiable people must not be used to imply endorsement, so it is used for tests only. | https://images.nasa.gov/details/NHQ202011150013 (file: `https://images-assets.nasa.gov/image/NHQ202011150013/NHQ202011150013~medium.jpg`) | `0ce236d6e9b007d509daefdcb53eece58fa79bbc37c7b9a3bb73ab6eb0d77ed8` |

No footage of any kind, and no restaurant imagery, is used in tests.

## Python packages (runtime extra `pose`; versions as locked in `uv.lock`)

| Package | Version | License | Source |
|---|---|---|---|
| onnxruntime | 1.31.1 | MIT | https://github.com/microsoft/onnxruntime |
| rtmlib | 0.0.16 | Apache-2.0 | https://github.com/Tau-J/rtmlib (pre/post-processing helpers for RTMPose) |
| opencv-python, opencv-contrib-python | 5.0.0.93 | Apache-2.0 (OpenCV 4.5+). The wheels bundle FFmpeg (LGPL) and Qt (LGPL). | https://github.com/opencv/opencv-python (pulled in by rtmlib; used for detector preprocessing) |
| numpy | 2.x | BSD-3-Clause | https://numpy.org |
| av (PyAV) | 15.x | BSD-3-Clause. The wheels bundle FFmpeg (LGPL/GPL build options need a check). | https://github.com/PyAV-Org/PyAV |
| protobuf, flatbuffers, tqdm | locked | BSD-3 / Apache-2.0 / MPL-2.0+MIT | transitive (onnxruntime, rtmlib) |

## Not used

- **Ultralytics YOLO**: AGPL-3.0, and it would need torch at runtime. The YOLOX/RTMPose ONNX models already run on ONNX Runtime with TensorRT, CUDA or CPU.
- **Face recognition or any biometric model**: never (ADR-003; BIPA, Texas, Washington). Staff vs customer is inferred by core from zones and cameras, not by a model.
- **OWLv2 and Grounding DINO** (open-vocabulary detection, e.g. for carried objects or cash): not tried. These are large ViT/Swin models; the estimate, not measured, is about 1 s or more per frame on a 4-vCPU CPU. A candidate for roadmap items on a GPU.
