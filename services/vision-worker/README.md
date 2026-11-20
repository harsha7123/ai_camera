# vision-worker

Camera ingest and analysis for the Zeoatap Restaurant Watchdog edge appliance. It reads the restaurant's existing CCTV cameras over RTSP, checks that each camera is healthy, finds and tracks people, and sends **observations** to core. Pipeline background: [AI_MODEL_STRATEGY](../../docs/AI_MODEL_STRATEGY.md); contract: [API.md](../../packages/contracts/API.md).

The worker only reports what it sees. Rules in core decide what is an incident, and a manager decides what an incident means (ADR-002). It never identifies anyone: there is no face recognition and no biometrics (ADR-003), every track has role `person`, track ids are anonymous and short-lived, and video stays on site. Core infers "staff" from time spent in `staff_area` zones and from `staff_only` cameras, never from the worker. Audio is never read.

> ⚠️ **Nothing here has been validated on restaurant footage.** The person detector and pose model are public pretrained weights. The quality checks, the tracker settings and the mock detector have only been exercised on synthetic test patterns, an adult test photo and unit tests. Expect false positives and misses until a site has been tuned (the 30–60 day SHADOW period).

## What it does
- Connects to each camera over RTSP (TCP) and **reconnects forever** with backoff (1 s → 30 s, jittered).
- Keeps a **rolling buffer of the original encoded packets** (default 120 s, capped by bytes). Evidence clips are cut by remuxing those packets to MP4 with **no re-encode**.
  - The buffer is **kept across reconnects**, so the video from just before an outage (often the evidence for `camera_tamper` or `after_hours_intrusion`) is not lost. Each connection's timestamps are rebased onto one clip timeline placed by receive time; an outage appears as a gap in the clip. If a camera comes back with different codec settings (e.g. another resolution), only the configuration with the most video in the window is written.
  - A clip is marked `partial` when the window's end was not recorded (outage, or the request timed out), when the buffer no longer reaches the requested start (evicted by age or bytes), when it has a hole longer than 3 s, or when part of it had to be left out.
- Samples frames by time: **5 fps** normally and **15 fps** on `priority` cameras (register/POS overheads). When analysis falls behind, it drops the oldest frame and counts the drop (`frames_dropped_total`).
- Checks image quality on a 160×90 thumbnail: **black** (3 s), **obstructed** or covered lens (5 s), **frozen** (30 s), with 5 s recovery hysteresis. **Degraded frames never run detection.** Frozen means consecutive thumbnails are (near-)bit-identical: no pixel differs by more than 1 grey level (rounding) for 30 s, which is the signature of a stalled encoder or decoder repeating frames. A live camera always has some sensor noise, so a legitimately still scene (an empty dining room or kitchen at night) is **not** flagged; flagging it would skip detection (no `after_hours_intrusion`) and raise `camera_tamper` every night. **Known limitation:** a camera whose sensor stalls but keeps updating an OSD clock overlay (or whose encoder adds fresh noise to a repeated image) is not detected as frozen; stall detection at the RTP/timestamp level is the roadmap fix. The black/obstructed thresholds are untested on real cameras and must be tuned per site.
- Emits **observations** (contract: [`packages/contracts/observation.schema.json`](../../packages/contracts/observation.schema.json), v2) to a JSONL file, or to core as NDJSON batches. Each observation carries `frame_size` (`[width, height]` of the analysed frame) so core can turn normalized boxes into real aspect ratios for `person_down`. A track with a NaN/inf or out-of-range value is dropped and counted (`invalid_tracks_total`), and output is serialized as strict JSON, so one model glitch can never put invalid JSON on the stream.
- Serves `/healthz`, `/readyz`, `/status`, Prometheus `/metrics`, and the clip control endpoint `POST /v1/clips`. It binds to **127.0.0.1:8081** by default.
  - `/readyz` is 503 unless every camera is streaming **and** the analysis loop is healthy. An exception in analysis or in the sink is caught, logged (rate-limited), and counted (`analysis_loop_errors_total`); after 5 failures in a row the worker reports not ready and `ai_available: false` in `/status` until a frame goes through again.

## Detectors (`--detector`)
| Value | What runs | `ai_available` | `source` |
|---|---|---|---|
| `none` (default) | camera health only | `false`, so core shows **AI_UNAVAILABLE**, never green | `none` |
| `mock` | no model: synthetic people walking through each camera's view (deterministic per camera id), for pipeline and UI tests only | `true` | `MOCK` (never present it as detection) |
| `person` | YOLOX person detector → ByteTrack-style tracker | `true` only while the models are loaded and running; `false` on any frame whose inference failed, and after 3 consecutive failures (retried every 5 s) | `zeoatap-person-p1`, with every model version in `model_versions` |
| `pose` | `person`, plus RTMPose on each person crop. It only adds the optional `pose_quality` and `visibility` fields; no rule requires them today | as `person` | `zeoatap-person-p1` (`model_versions.pose` is set) |

Licenses, sources and sha256 hashes of the models are in [MODELS.md](MODELS.md).

Pipeline details:
- **Frames:** with `person`/`pose`, the camera thread also queues a ~640-px-wide RGB frame (`--analysis-width`). The queue holds 4 frames per camera (about 0.7 MB each at 640×360) and drops the oldest.
- **Detector:** `yolox-m-humanart` by default, or `yolox-tiny-humanart` (`--det-model`). It runs on ONNX Runtime, which picks TensorRT, then CUDA, then CPU, whichever is installed (`--device auto|cpu`, `--threads`).
- **Tracker:** ByteTrack two-stage association: high-score detections first, then low-score ones, to keep partly occluded people (behind a counter, passing a table). It uses a Kalman filter and greedy IoU matching. Ids look like `3f9a-7`: a random per-process prefix plus a counter, per camera, gone 2 s after a person is lost. A track is emitted only after 2 hits. Not evaluated on crowded restaurant scenes; queue counts and dwell times depend on it.
- **Outputs:** `role` is always `person`. `box` is normalized `[x1,y1,x2,y2]` in [0,1]. With `pose`, `pose_quality` is the mean confidence over visible keypoints (score ≥ 0.3) and `visibility` is the fraction of the 17 keypoints that are visible.

### Getting the models
```bash
uv sync --extra pose
uv run python scripts/fetch_models.py --test-media   # YOLOX-m + RTMPose-m (+ adult test photo); --all for -tiny/-s
```
Models go to `models/` (git-ignored; override with `$ZEOATAP_MODEL_DIR`). Every file is checked by sha256 when it is downloaded and again when it is loaded. If a model is missing, `--detector person|pose` logs an error and keeps running with `ai_available=false`.

### CPU throughput (historical, 4-vCPU dev container, no GPU)
Measured earlier with `scripts/bench_pipeline.py` on the adult test photo at 640×390, with 7–9 people in view, with pose on. Each figure covers one analysis thread across all cameras. `person` without pose is faster; it has not been re-measured.

| Detector + pose | fps (quiet machine) | fps (shared machine, load average 9–12) |
|---|---|---|
| YOLOX-m + RTMPose-m | 2.1 | 0.7–1.5 |
| YOLOX-tiny + RTMPose-s | 6.4 | 2.2–4.2 |

On CPU the default models cannot keep up with even one camera at 5 fps: frames are dropped and counted, never queued without bound. A register camera at 15 fps needs a GPU. Production sizing assumes a GPU and TensorRT (see [BENCHMARK_RESULTS](../../docs/BENCHMARK_RESULTS.md)).

## Camera config
See [`cameras.example.json`](cameras.example.json); the ids match [`services/core/site.example.json`](../core/site.example.json).

| Field | Meaning |
|---|---|
| `id` | camera id, as in core's site config |
| `url` | RTSP URL **without** credentials (IPv6 literals such as `rtsp://[fe80::1]:554/x` are supported) |
| `credentials_env` | name of the environment variable holding `user:password` |
| `priority` | `true` for register/POS cameras: sampled at `priority_fps` (15) instead of `base_fps` (5). The old name `protected` is still read, with a warning |
| `base_fps`, `priority_fps`, `ring_seconds`, `ring_max_bytes` | optional tuning |

## Sinks (`--sink`)
- `jsonl` (default): one observation per line to `--observations` (a path, or `-` for stdout).
- `core`: `POST {--core-url}/internal/v1/observations` (default `http://127.0.0.1:8090`) as NDJSON (`Content-Type: application/x-ndjson`) with `Authorization: Bearer $ZEOATAP_INTERNAL_TOKEN`.
  - Batches hold up to 200 lines or 200 ms.
  - Connect timeout is 2 s and read timeout is 5 s.
  - Network errors, 5xx, 503 and 401/403 are retried with jittered backoff (0.25 s → 10 s), and batch order is kept.
  - On a `503` with `line`, core already queued the lines before `line`; only the rest is resent, so nothing is duplicated.
  - On a `400`, the bad line (index `line`; `accepted` from an older core) is dropped and counted, and the lines after it are resent.
  - Lines core ignored (unknown camera) are counted (`ignored_total`), not resent.
  - The buffer is bounded (`--sink-buffer`, default 5000). When it is full, the **oldest** observation is dropped and counted. The analysis thread never waits on the network.
  - Counters are in `/status` (`sink`) and `/metrics` (`zeoatap_sink_*`). The token never appears in logs or status.

## Clip endpoint (`POST /v1/clips`, core → vision)
Request `{camera_id, start, end, path}`, with start and end as unix seconds. The response is `200 {path, sha256, partial}`, as in [API.md](../../packages/contracts/API.md).

Clips are only ever written inside the spool directory shared with core: `--clip-dir`, else `$ZEOATAP_CLIP_SPOOL_DIR`, else `/var/lib/zeoatap/spool` (core's default). The requested directory is resolved (symlinks followed) and must be inside the resolved spool; a path whose file name is a symlink is refused. The returned `path` is the resolved one.

| Status | When |
|---|---|
| 401 | the bearer token does not match `$ZEOATAP_INTERNAL_TOKEN` (compared in constant time) |
| 503 | no token is configured (endpoint disabled), or more than 8 clip requests are already in progress |
| 415 | the request is not `application/json` |
| 400 | invalid JSON, fields or window: end ≤ start, longer than 600 s, more than 600 s in the future, a path that is not absolute `.mp4`, a path outside the spool directory, or a symlink |
| 404 | unknown camera |
| 422 | no buffered video covers the window |
| 504 | the clip was not written by end + 120 s + 15 s |

The request blocks until the clip is written. The server listens on 127.0.0.1 only unless `--health-host` says otherwise, and it logs a warning for a non-loopback address.

## Run
```bash
uv sync --extra pose
export CAM_COUNTER_RTSP_CREDS='user:password'   # one per camera, from the secret store, never in the config file
export ZEOATAP_INTERNAL_TOKEN=...               # shared with core; enables /v1/clips and --sink core
uv run zeoatap-vision --config cameras.example.json --detector person --sink core --clip-dir /var/lib/zeoatap/spool
uv run zeoatap-vision --config cameras.example.json --observations obs.jsonl --detector none   # health only
curl -s localhost:8081/status
```
Credentials are injected from the named environment variable and redacted (`rtsp://user:****@host`) in every log and error. The config loader rejects URLs that contain credentials.

Not done yet:
- clip encryption (core does it)
- RTCP/NTP timestamps (`ts_source: "receive"`)
- batching frames from several cameras on the GPU
- stall detection at the RTP/timestamp level (catches a frozen sensor behind a live OSD clock)
- any model or threshold tuned on restaurant footage (queue/dwell accuracy, `person_down` box shape, frozen/obstructed thresholds)
- hand/cash, object-carry, fire/smoke, weapon and PPE detection (see [FEATURE_ROADMAP](../../docs/FEATURE_ROADMAP.md))

## Test
```bash
uv sync --extra pose
uv run pytest -q
```
- `tests/test_units.py`: ring buffer (including consistent reads under concurrent clears), quality checks (frozen on identical or rounding-only repeats; a still scene with sensor noise is not frozen; a changing clock overlay defeats frozen detection, the documented trade-off), sampling, backoff, secrets handling (including IPv6 hosts), the `priority` rename, the example config against the example site, and contract validation.
- `tests/test_analysis_units.py`: tracker (stable ids, low-score second stage, expiry, random id prefix), pose metrics, model hash checks, schema-valid pipeline output with role `person` and `frame_size` (with and without pose), NaN detections never reaching the JSON stream, the mock detector, the analysis-loop exception guard, thread-safe pipeline status, degraded frames skipping detection, and failed inference giving `ai_available=false`.
- `tests/test_clip_unit.py`: clips from real H.264 packets encoded in memory: a failed mux never corrupts buffered packets, `partial` on eviction / missing end / outage gaps, clips across a reconnect (timestamp restart) and a resolution change, and clip-path confinement (outside paths, symlinked directories and files).
- `tests/test_sink.py`: CoreSink against a local fake core: batching and order, retries on 503/500/timeouts, a 503 after a partial accept (no duplicates), 400 bad-line handling (v2 `line` and the older `accepted`), ignored lines, NaN observations, a wrong token, and backpressure (drop-oldest, never blocks).
- `tests/test_clip_api.py`: `/v1/clips` auth, validation, spool confinement (including the default spool), 404 and 422, and a real clip over live RTSP.
- `tests/test_detection_smoke.py`: the full pipeline (with pose) on a **public-domain photo of adults** (NASA). Skipped unless the models and the photo were fetched. It is not an accuracy test.
- `tests/test_live.py`: real RTSP through [MediaMTX](https://github.com/bluenviron/mediamtx), with ffmpeg publishing **synthetic test patterns** (no people, no footage). It is skipped unless MediaMTX is at `$MEDIAMTX_BIN` or `<repo>/.tools/mediamtx` and ffmpeg (with libx264) is on PATH. MediaMTX runs TCP-only, so it does not clash with another instance on UDP 8000/8001.
