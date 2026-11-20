# ADR-005: Video pipeline — PyAV + ONNX Runtime first, TensorRT/DeepStream after benchmark
**Status:** Proposed · **Date:** 2026-10-27, revised 2026-11-20

## Context
DeepStream offers high density but is proprietary and version-locked. A restaurant has 6–16 cameras, far below the ≈ 46 cameras/GPU inference bound measured for YOLOX-M + RTMPose-m with TensorRT FP16 ([BENCHMARK_RESULTS](../../BENCHMARK_RESULTS.md)).

## Decision
The worker uses PyAV (RTSP, depacketize, decode), an encoded-packet ring buffer for clips, and ONNX Runtime for inference. TensorRT FP16 and cross-camera batching are the next optimisation; DeepStream is adopted only if it gives ≥ 1.5× density at equal accuracy and acceptable licence terms (OQ-L4) — unlikely to matter at restaurant scale.

## Consequences
Simple, debuggable pipeline. Measured capacity figures are upper bounds until the worker uses TensorRT.
