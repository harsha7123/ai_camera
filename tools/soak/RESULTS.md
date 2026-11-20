# Soak / stress results: vision-worker on a 4-vCPU CPU-only box

**Date:** 2026-10-31. All inputs are synthetic lavfi test patterns (no footage, no people). Every number below was measured in this session. The raw per-sample data is in `results/*.json`.

> **Read this first.**
> - These runs used the **pre-pivot code**: the infant-care vision-worker, before the restaurant pivot. The `pose` run used that pipeline (YOLOX-tiny + RTMPose-s, plus infant-specific stages that have since been removed). They have not been re-run on the restaurant code.
> - All cameras were **synthetic** RTSP publishers on the same machine, not real IP cameras.
> - **Naming.** The camera flag was called `protected` then; it is now `priority` (register/POS cameras, analysed at 15 fps instead of 5). This document says "priority". The raw JSON files keep the old `protected` keys, and `summarize.py` reads either.
> - Corrections (2026-11-20): the N = 32 run is labelled as the mock detector (it was never "no detector"); drop rates now separate the measured window from the whole run; the per-camera memory slope is 26–34 MB; the fault-run narrative no longer claims observations that were not sampled; "analyzed fps" no longer claims every frame reached the detector.

## Machine
| | |
|---|---|
| CPU | Intel Xeon @ 2.10 GHz, 4 vCPU (cloud container), no GPU |
| RAM | 15.7 GB |
| Kernel | 6.18.44 |
| Software | Python 3.13.17, ffmpeg 6.1.1 (libx264), MediaMTX (`.tools/mediamtx`), vision-worker as of this commit |

**Caveat: shared machine.** Other agents were building and testing in the same container during these runs. The "Host CPU %" column, and the 3-second baseline taken just before each run (in brackets), include their load: the baseline ranged from 0.1% to 98.7%. The per-process numbers (vision-worker, MediaMTX, ffmpeg) are measured per process tree with psutil and are the reliable ones. Each configuration ran once, with no repeats.

## Commands
```bash
cd tools/soak
uv sync
./run_matrix.sh     # none + mock: N = 4, 8, 16 at 640x360 and N = 4, 8 at 1280x720, 60 s each, plus the fault run
uv run python soak.py --cameras 32 --resolution 640x360  --duration 60 --detector mock --out results/mock-640x360-n32.json
uv run python soak.py --cameras 16 --resolution 1280x720 --duration 60 --detector mock --out results/mock-1280x720-n16.json
uv run python soak.py --cameras 4  --resolution 640x360  --duration 60 --detector pose \
    --worker-arg=--det-model=yolox-tiny-humanart --worker-arg=--pose-model=rtmpose-s-body7 --worker-arg=--device=cpu \
    --out results/pose-640x360-n4.json
uv run python summarize.py results/*.json
```
Setup for every run:
- One MediaMTX, N ffmpeg publishers (`-re`, lavfi pattern, 25 fps, libx264 ultrafast/zerolatency, GOP 25, RTSP/TCP), and **one** vision-worker process for all N cameras.
- Half the cameras are priority (`protected` at the time; target 15 fps) and half normal (target 5 fps).
- Observations go to `/dev/null`.
- The worker gets 10 s of warm-up after all cameras reach STREAMING, then 60 s are measured, sampled every 2 s.
- CPU % is per core: 100% = one vCPU, 400% = the whole box.

## Results
*Analyzed fps* = sampled − dropped, per camera: frames that left the queue and were processed by the analysis loop (each one produced an observation). It is **not** the detector rate: frames the worker judged degraded skip the detector, so the worker's `frames_analyzed_total` (detector calls) is lower, e.g. 17,573 detector calls against 21,144 processed frames over the whole N = 32 run, and 1,660 against 1,868 in the pose run. "worst 2 s" is the lowest analyzed fps of any priority camera in any 2-second sample interval. "Dropped" is counted over the 60 s measured window only.

| Detector | Res | N | vision-worker CPU % mean (max) | worker RSS MB | ffmpeg pubs CPU % | MediaMTX CPU % | Host CPU % mean (baseline) | Decoded fps/cam (min) | Priority analyzed fps mean / min cam / worst 2 s | Normal analyzed fps mean / min cam | Dropped | Decode err | Reconnects |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 640x360 | 4 | 10.6 (12.0) | 166 | 23.2 | 3.1 | 91.5 (5.7) | 25.0 (25.0) | 14.92 / 14.90 / 13.5 | 5.00 / 5.00 | 0 | 0 | 0 |
| none | 640x360 | 8 | 21.4 (24.5) | 300 | 60.8 | 7.0 | 40.6 (75.2) | 25.0 (25.0) | 14.98 / 14.97 / 14.0 | 5.00 / 5.00 | 0 | 0 | 0 |
| none | 640x360 | 16 | 39.7 (45.9) | 509 | 115.8 | 12.9 | 67.0 (28.1) | 25.0 (25.0) | 14.90 / 14.85 / 13.2 | 5.00 / 4.98 | 0 | 0 | 0 |
| none | 1280x720 | 4 | 18.2 (22.1) | 266 | 65.3 | 4.2 | 64.7 (45.7) | 25.0 (25.0) | 14.97 / 14.93 / 14.0 | 5.00 / 5.00 | 0 | 0 | 0 |
| none | 1280x720 | 8 | 41.6 (48.4) | 502 | 161.2 | 11.5 | 75.0 (2.7) | 25.0 (25.0) | 14.95 / 14.90 / 14.0 | 5.00 / 5.00 | 0 | 0 | 0 |
| mock | 640x360 | 4 | 11.0 (12.5) | 166 | 25.6 | 3.2 | 44.2 (2.8) | 25.0 (25.0) | 14.98 / 14.98 / 14.5 | 5.00 / 5.00 | 0 | 0 | 0 |
| mock | 640x360 | 8 | 19.6 (23.5) | 303 | 51.8 | 7.4 | 76.5 (31.7) | 25.0 (25.0) | 14.96 / 14.95 / 14.0 | 5.00 / 5.00 | 0 | 0 | 0 |
| mock | 640x360 | 16 | 35.2 (39.1) | 512 | 99.7 | 11.7 | 91.7 (98.7) | 25.0 (25.0) | 14.81 / 14.73 / 13.4 | 5.00 / 5.00 | 0 | 0 | 0 |
| mock | 640x360 | **32** | 77.3 (82.1) | 936 | 216.1 | 20.1 | 80.0 (0.3) | 25.0 (25.0) | **14.08 / 13.55 / 9.5** | 5.00 / 4.97 | **277** | 0 | 0 |
| mock | 1280x720 | 4 | 18.1 (21.0) | 266 | 63.9 | 3.9 | 31.8 (33.9) | 25.0 (25.0) | 14.90 / 14.83 / 11.5 | 5.00 / 5.00 | 0 | 0 | 0 |
| mock | 1280x720 | 8 | 41.4 (48.5) | 502 | 161.7 | 11.2 | 66.4 (2.7) | 25.0 (25.0) | 14.99 / 14.98 / 14.5 | 5.00 / 5.00 | 0 | 0 | 0 |
| mock | 1280x720 | **16** | 72.5 (86.1) | 916 | 294.1 | 17.9 | 97.9 (0.4) | 25.4 (25.1) | **11.88 / 11.00 / 7.0** | 4.90 / 4.80 | 0 | 0 | 0 |
| **pose** (YOLOX-tiny + RTMPose-s, ONNX Runtime CPU) | 640x360 | 4 | **369.2 (373.1)** | 373 | 23.4 | 3.1 | 100.0 (0.1) | 25.0 (25.0) | **8.43 / 8.43 / 6.0** | 5.00 / 5.00 | **788** | 0 | 0 |

### Fault injection (mock, 640x360, N = 8)
Command: `soak.py --cameras 8 --duration 60 --detector mock --fault-at 20 --fault-down-s 8`. At t = 20 s the publisher of `cam01` (a priority camera) was killed with SIGKILL, kept down for 8 s, then restarted.

In this version of `soak.py` the fault injection ran inside the sampling loop and **blocked it**: there are no samples between t = 20 s and t = 36 s, and the t = 36 s sample is one 16-second interval. (`soak.py` now runs the fault in a background thread, so sampling continues.)

- vision-worker reported `cam01` **RECONNECTING 0.01 s** after the kill (the RTSP TCP connection closes at once).
- `cam01` was back to **STREAMING 6.71 s after the publisher restarted**, after 4 reconnect attempts. Exponential backoff (1 → 2 → 4 s, jittered) means recovery waits for the next attempt.
- The t = 36 s sample shows `cam01` at 1.19 fps: that is the average over the whole 16 s interval (t = 20–36), most of which the camera was down. About 19 frames over 16 s matches roughly 1.3 s of streaming at 15 fps after recovery at t ≈ 34.7 s. From the next sample on it analyzed 15.0 fps.
- The other 7 cameras: their counters show 0 drops and 0 reconnects over the whole window (all 4 reconnects were `cam01`'s), and their 16 s averages over t = 20–36 were 14.88–15.0 fps (priority) and 5.0 fps (normal). They were STREAMING at the t = 20 s and t = 36 s samples, but their state in between was **not observed**.
- Core's view of this (CAMERA_UNAVAILABLE 3 s after the last observation, then recovery) is covered by `services/vision-worker/tests/test_live.py`. It was not re-measured here.

## Interpretation
1. **Decode is not the bottleneck at 640x360 up to 16 cameras.**
   - With no detector or the mock detector, one vision-worker decoding 16 × 25 fps of 640x360 H.264 used about 0.4 vCPU (35–40%). Every priority camera stayed within 0.2 fps of 15, normal cameras held 5, and nothing was dropped.
   - Cost scales roughly linearly: about 2.2–2.7% of a core per 640x360 camera and about 4.5–5.2% per 1280x720 camera at 25 fps input.
2. **Where it breaks (mock detector, no real inference), 640x360 at N = 32.** Only the mock detector was run at N = 32.
   - The worker used 0.77 vCPU while the host was not saturated (worker + publishers + MediaMTX ≈ 3.1 of 4 vCPU).
   - Priority cameras fell to 14.1 fps mean (13.55 for the worst camera, 9.5 in the worst 2-s interval). 277 frames were dropped in the 60 s window, about 1.5% of the ≈18,600 frames sampled in that window. Over the whole run, including connect and warm-up, 693 of 21,837 sampled frames were dropped (3.2%).
   - The worker could not use more than about one core even though cores were free. This points at the single-process design (GIL, plus the one analysis thread draining every camera's queue), not raw decode throughput. This is an inference from the CPU pattern, not profiled.
   - **Priority cameras did not keep 15 fps at N = 32.**
3. **1280x720 at N = 16: the box saturated** (host 97.9%). The synthetic publishers alone used 2.9 vCPU, which a real deployment would not run on the edge box. The worker got 0.73 vCPU, and priority cameras fell to 11.9 fps mean (7.0 worst interval), with no queue drops. The shortfall comes from frames not being decoded and sampled in time, not from analysis drops. This run says more about the box being shared with 16 encoders than about the worker. N = 4 and 8 at 1280x720 held 15/5 fps with 0 drops.
4. **A real detector on CPU is far below need.**
   - `--detector pose` (YOLOX-tiny 416 + RTMPose-s, ONNX Runtime CPU) used all 4 vCPU (369%) at N = 4. It averaged 41.9 ms per detector call (`mean_total_ms` in the worker's `/status`), so at most about 24 detector calls/s in total.
   - Priority cameras got only **8.4 fps** (6.0 worst interval), against 15 needed. Normal cameras kept 5 fps.
   - 788 frames were dropped in the 60 s window (about 33% of the ≈2,400 frames sampled in it; 948 of 2,816, 34%, over the whole run). Drop-oldest kept the stream fresh rather than letting latency grow.
   - This agrees with COST_AND_DEPLOYMENT §7 ("CPU-only cannot provide fall detection at the required fps"). A GPU (or a much cheaper detector) is required even for a 4-camera pilot.
5. **ffmpeg publishers cost more CPU than the worker** (for example 1.6 vCPU against 0.4 for N = 8 at 720p). They exist only to simulate cameras. On a real edge box the cameras encode, so subtract the publisher column when sizing.
6. **Robustness:** no decode errors and no unplanned reconnects in any run. Memory grows with N because of the 120 s encoded ring buffers per camera (≈ 26–34 MB per extra 640x360 camera and ≈ 52–59 MB per extra 1280x720 camera at these synthetic bitrates, from the worker's peak RSS between consecutive N).

**Not measured:** GPU/NVDEC decode, observation latency (capture → core), runs longer than 60 s, repeated runs (variance), and the pose detector at N > 4 or at 1280x720.
