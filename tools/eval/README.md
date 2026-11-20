# tools/eval: event-level accuracy evaluation

This harness scores system incidents against adjudicated ground truth for the restaurant event types in [API.md](../../packages/contracts/API.md): `after_hours_intrusion`, `camera_tamper`, `restricted_zone_entry`, `person_down`, `long_queue`, `long_wait`, `unattended_post`, `pos_no_sale` and `pos_refund_no_customer`. It computes event-level metrics, checks them against pre-registered pilot goals and gives a go/no-go per event type. The validation process it implements is described in [SAFETY_VALIDATION](../../docs/SAFETY_VALIDATION.md).

**No validation has been run with it on real data.** The only inputs so far are synthetic test fixtures, the synthetic Harbor Grill example in `examples/`, and a synthetic test-pattern video (smoke run below, before the restaurant pivot).

```bash
cd tools/eval
uv sync
uv run pytest -q                       # 57 unit tests
uv run zeoatap-eval validate examples/ground_truth.example.json
uv run zeoatap-eval evaluate --ground-truth examples/ground_truth.example.json \
    --incidents examples/incidents.replay.example.jsonl --out-md report.md --out-json report.json
```

## What it computes

| Metric | How |
|---|---|
| Matching | Same `event_type`, an incident camera in the session's cameras, and either temporal overlap or incident start in [GT.start − 1 s, GT.end + `latency_budget`]. An incident created more than the pre-tolerance before GT.start is never matched (it cannot have detected the event); such pairs are listed under "Rejected: created before the event started" and flagged in the warnings, because they usually mean misaligned clocks. One-to-one via the Hungarian algorithm (scipy) on temporal IoU. Weights are `BIG + IoU`, so the solver first maximises the number of matched events, then total IoU. With pure IoU weights, one high-IoU pair could leave a second event unmatched (see `test_hungarian_maximises_matched_events_before_iou`). |
| Session scope | An incident belongs to a session when it shares a camera with it and starts inside the operating span. An incident that starts after the span ends is still in scope if it is within the latency budget of one of the session's events (an event near the end of a recording is confirmed after it). Other incidents outside the span are out of scope and never scored. |
| Duplicates | Eligible incidents left unassigned. They are not TPs. They lower precision and dedup accuracy. They are not false alerts unless you pass `--count-duplicates-as-false-alerts`. |
| Recall, missed-event rate | Exact 95% Clopper–Pearson interval. When there are 0 misses, the rule-of-three bound 3/n is also shown. For 0/30 misses the exact two-sided upper bound is 0.1157, the one-sided bound is 0.0950, and the rule of three gives 0.100. |
| Precision | Matched conclusive incidents ÷ all conclusive in-scope incidents (duplicates included), with Clopper–Pearson. |
| INCONCLUSIVE | Kept separate. A GT event covered only by an `INCONCLUSIVE` incident gets the outcome `inconclusive`, not `detected`. Inconclusive incidents never count as FP or TP. `recall_including_inconclusive` is reported alongside. |
| False alerts / camera-hour | Unmatched conclusive incidents ÷ FULLY_OPERATIONAL camera-hours, with an exact Poisson interval. By default every status except `INCONCLUSIVE` counts (`ALERTED`, `SHADOW` and `REVIEW_QUEUED`), so review-policy types (`restricted_zone_entry`, `long_wait`, `pos_no_sale`) are held to their false-prompt goal too; `--alert-statuses ALERTED,SHADOW` narrows it. With `--observations obs.jsonl`, operational time is rebuilt the way core's `cameraHealth.stateAt` does it (stale > 3 s → CAMERA_UNAVAILABLE, `ai_available=false` → AI_UNAVAILABLE, degraded → VIDEO_DEGRADED). Non-operational hours are reported separately. Without state data, all scheduled time counts as operational, and the report says so. |
| Latency | `created_at − GT.start` (median, p95, max). For replay output, `created_at` is the incident's `end` on its `incident_created` line, i.e. the moment the rule confirmed it. For API exports it is the `created_at` field. For dwell rules the latency includes the rule's threshold (60 s for `long_queue`, 8 min for `long_wait`, 3 min for `unattended_post`, 30 s for `camera_tamper`). |
| Dedup accuracy | GT events with exactly one incident ÷ all GT events. Also reported over detected events only. |
| Confusion | Per GT type: detected / INCONCLUSIVE / missed / `wrong_type:X`. A miss where an incident of another type overlapped is counted under the type the system reported. A nearby unmatched incident of the same type is a plain miss. |
| Strata | Recall, latency and false alerts per `lighting` (day / night / after_hours_dark), `crowding` (empty / normal / rush) and `camera_view` (overhead / 360 / wide). Event-level `conditions` override the session's. |
| Hard negatives | Non-events that look like events (customer bending down, staff in the cooler, a refund with the customer present, cleaning crew, lights off at close, a queue of four) listed per session. An FP that overlaps one is labelled with it. |

Incident files can be replay JSON lines, a JSON array (`GET /api/v1/incidents`), `{"incidents": [...]}`, or a single incident object, compact or pretty-printed.

### Pre-registered pilot goals
Defaults are in [`goals.py`](src/zeoatap_eval/goals.py); override them with `--goals goals.json`. They are proposed engineering goals, written down before any data is scored. They are not results.

| Event type | Code | Stage | Recall LB ≥ | n (min) | Precision LB ≥ | FA / cam-h ≤ | Latency p95 ≤ | Budget after GT.end | Required strata (each needs the same n) |
|---|---|---|---|---|---|---|---|---|---|
| after_hours_intrusion | G1 | Pilot alert, shadow first | 0.95 | 72 | | 0.01 | 10 s | 5 s | lighting night, after_hours_dark |
| camera_tamper | G3 | Pilot alert, shadow first | 0.95 | 72 | | 0.01 | 60 s | 45 s | lighting day, after_hours_dark |
| restricted_zone_entry | D5 | Pilot review | 0.90 | 60 | | 0.02 | 10 s | 5 s | lighting day, night |
| person_down | F6 | Shadow (heuristic) | 0.80 | 30 | | 0.02 | 10 s | 5 s | crowding empty, normal; camera_view overhead, 360 |
| long_queue | A4 | Pilot alert (operations) | 0.70 | 30 | 0.80 (n ≥ 30) | | 120 s | 90 s | crowding rush |
| long_wait | A4 | Pilot review (operations) | 0.70 | 30 | 0.70 (n ≥ 30) | 0.05 | 600 s | 600 s | crowding normal, rush |
| unattended_post | B4 | Pilot alert (operations) | 0.80 | 30 | 0.80 (n ≥ 30) | | 240 s | 240 s | crowding normal, rush |
| pos_no_sale | C1 | Pilot review (POS) | 0.99 | 368 | | 0.01 | 30 s | 30 s | – (POS only) |
| pos_refund_no_customer | C3 | Shadow → alert (POS + vision) | 0.90 | 60 | | 0.02 | 30 s | 30 s | crowding empty, normal |

Every pre-registered n can demonstrate its goal: with n positives and zero misses, the exact two-sided 95% lower bound reaches the goal (`test_default_goals_are_achievable`). For example, `pos_no_sale` at 0.99 needs 368 zero-miss positives two-sided (0.025^(1/368) = 0.99003) and 300 one-sided (rule of three; the exact one-sided bound needs 299). 300/300 is **not** enough under the default two-sided decision (lower bound 0.9878). `long_queue` and `unattended_post` are operations alerts: precision is the main goal because managers stop reading a noisy alert.

### Go / no-go
Every event type in the GT that has a deployable, non-research goal must PASS for **GO**. For each type the tool checks:

- **Recall:** the 95% Clopper–Pearson lower bound must be ≥ the goal. The default is two-sided (conservative). `--decision-sided one` uses one-sided bounds, which match rule-of-three arithmetic.
- **Small-n refusal:** the verdict is `INSUFFICIENT_DATA` (never PASS) when n < max(pre-registered n, rule-of-three n = ⌈3/(1−goal)⌉, exact zero-miss n). The check reports how many misses are still allowed at that n. If even the upper bound is below the goal, the verdict is FAIL whatever the n.
- **Required strata:** each listed stratum value needs the same n and bound as the overall goal. This applies to every type with a stratum requirement. Unknown stratum keys or values in a goals file are rejected.
- **Precision** (where set): same rules as recall, over conclusive incidents.
- **Stratum floor:** no stratum with n ≥ 5 may fall below 80% of overall recall.
- **False alerts:** FA/camera-hour upper bound ≤ goal. With fewer camera-hours than needed to bound the rate with 0 observed (3.69/goal two-sided, 3.00/goal one-sided), the verdict is `INSUFFICIENT_DATA`. A 0.01 goal needs 369 operational camera-hours.
- **Latency:** p95 ≤ goal.
- **Source:** any `MOCK` source gives `INVALID_SOURCE`.

Global blockers: the dataset is not `locked`; any GT event has fewer than 2 annotators or is not adjudicated; MOCK observations or incidents in the input. The manual checklist (shadow period, failure injection, privacy/legal review, manager briefing that alerts are review prompts, signed release manifest) is listed in the report but not verified.

## Ground-truth format
The schema (v2) is in [`src/zeoatap_eval/ground_truth.schema.json`](src/zeoatap_eval/ground_truth.schema.json) and an example (Harbor Grill: counter at lunch rush, back of house after close, dining room at night) is in [`examples/ground_truth.example.json`](examples/ground_truth.example.json). There is one entry per recording session:

- Pseudonymous `session_id`, `facility_id` and `camera_id` (`extra_camera_ids` for other cameras on the same room zones). Optional `room_id`, `subject` (an actor id such as `actor-A2`, never a real name or POS employee number) and `consent_ids` (written acknowledgments).
- `conditions`: `lighting` ∈ day/night/after_hours_dark, `crowding` ∈ empty/normal/rush, `camera_view` ∈ overhead/360/wide.
- `operating_span`: the fully annotated time. Only this span counts as analyzed time.
- `events`: `{id, event_type, room_zone, start, end, visibility, annotator_confidence, annotators, adjudicated[, pos_ref]}`. `event_type` must be one of the nine API.md types.
- `hard_negatives`.

Times are either RFC 3339 (`start`/`end`) or seconds from the video's frame 0 (`start_s`/`end_s`, which need the session's `t0`). Annotating in video seconds and letting the replay script fill in `t0` is the normal path.

## How to annotate

### Event definitions
- **Start is the onset of the condition**, not the moment the rule's threshold is reached: the frame the intruder enters, the cover reaches the lens, the person is on the floor, the fifth person joins the queue, the post becomes empty, the POS event's timestamp. A span shorter than the rule's threshold (a 40 s queue of five, a 2-minute empty post) is a hard negative, not an event.
- **End** is when the condition stops (person leaves, cover removed, person up, queue below the threshold, post staffed again). For POS events, end = start + 1 s.
- `after_hours_intrusion`: a person in view outside the staff window (business hours plus the pre-open and post-close allowances in the site config). Cleaning crews or deliveries inside the window are hard negatives.
- `camera_tamper`: covered, sprayed, turned away, unplugged or frozen. Lights switched off at close are a hard negative.
- `restricted_zone_entry`: a person who is not staff in a `restricted` or `secure` zone. Staff entering the cooler are hard negatives. Staff status comes from the scenario script, never from recognising a face.
- `person_down`: staged falls on a mat by trained actors only. Bending, tying a shoe, sitting on the floor are hard negatives.
- `pos_no_sale` / `pos_refund_no_customer`: from the POS journal, reconciled with video. A refund with the customer at the counter is a hard negative for `pos_refund_no_customer`.

### Recording protocol
- **People.** Staged sessions use staff or actors who have signed the written monitoring acknowledgment. Audio is never recorded. No cameras or footage in restrooms or changing areas.
- **Counts per event type and per required stratum:** see the goals table. The harness enforces them.
- **Splits:** split by recording session (and by site and camera where possible). Hold out at least one site or floor layout. Lock and version the test set (`dataset.locked: true`).

### CVAT workflow
1. Create a CVAT task per recording session from the video file. Keep the frame rate (the import needs `--fps`).
2. Add one label per event type, named exactly like core's `event_type` (e.g. `person_down`). Give it these attributes: `visibility` (select: visible, partial, not_visible), `annotator_confidence` (select: certain, likely, unsure) and `room_zone` (text).
3. For each event, draw a **track** (a box around the person, the queue or the register is fine). Its first visible keyframe is the event start frame. Set **outside** on the first frame after the event ends. A track that leaves and re-enters becomes two events.
4. At least **two annotators** label each session independently in separate jobs or tasks. Export each as **"CVAT for video 1.1"** XML.
5. Import, match and compute agreement. Only labels that are API.md event types are imported (other tracks, such as helper `person` boxes, are skipped; `--labels all` imports every track). The strata are required:
   ```bash
   uv run zeoatap-eval cvat-import --xml ann1.xml --annotator ann-03 --xml ann2.xml --annotator ann-07 \
       --fps 15 --session-id S-0001 --facility-id F-harbor --camera-id cam-counter --room-id counter \
       --duration-s 900 --lighting day --crowding rush --camera-view overhead --out S-0001.gt.json
   ```
   Events both annotators marked (same label, overlapping, Hungarian on IoU) become GT events with `adjudicated: false`, spanning the earliest start to the latest end. Events only one annotator marked go to `S-0001.gt.adjudication.json`. The agreement (matched counts, mean temporal IoU, Cohen's κ on 1 s bins per label) is printed.
6. A senior reviewer resolves the adjudication queue, narrows boundaries and sets `adjudicated: true` (plus `adjudicator`). Then merge the sessions into one file, set `dataset.locked: true` for a test set, and run `zeoatap-eval validate`.

## End to end: video → incidents → report
[`scripts/run_pipeline.py`](scripts/run_pipeline.py) runs the whole chain for one local video file:

```
video ──ffmpeg -re──▶ MediaMTX (RTSP, runOnDemand) ──▶ vision-worker --detector X ──▶ observations.jsonl
      ──▶ go replay (services/core/cmd/replay) ──▶ incidents.jsonl ──▶ zeoatap-eval ──▶ report.md / report.json
```

```bash
cd tools/eval
uv run python scripts/run_pipeline.py --video S-0001.mp4 --ground-truth S-0001.gt.json --session-id S-0001 \
    --core-cameras core-cameras.json --priority --detector pose \
    --worker-arg=--det-model=yolox-tiny-humanart --out out/S-0001
```

- `--detector` is passed to `zeoatap-vision` and checked against its own `--help` at run time. Pass any other worker flags with repeated `--worker-arg=...`, and extra replay flags with `--replay-arg=...`.
- `--priority` marks the camera as a register/POS camera (analysed at 15 fps instead of 5).
- `--core-cameras` is the replay's `-config` file: cameras and zones (`{"cameras":[{"id","room_id","zones":[{"id","room_zone","kind","polygon":[{"X","Y"}…]}]}]}`, zone kinds as in API.md). Without it the replay has no zones, so zone rules (restricted entry, person down in a floor zone, queue, post, customer side) cannot fire.
- The POS rules need POS events. This script only feeds video observations; the POS types can be scored here only if the replay build accepts POS events through `--replay-arg`. Otherwise score them from core's API export (`GET /api/v1/incidents`).
- MediaMTX starts the publisher only when vision-worker connects. By default the first frame is held for 3 s (`--lead-in-s`), so the worker is decoding before video frame 0. This forces a libx264 re-encode. `--lead-in-s 0 --transcode copy` publishes the original bitstream, but the first ~1.5 s are then not analyzed. The wall time of frame 0 becomes the session's `t0`. Expect roughly 0.1–0.5 s of alignment error (`run.json` records the first-observation offset). Audio is always dropped.
- Requirements: MediaMTX at `.tools/mediamtx` (or `$MEDIAMTX_BIN`), ffmpeg/ffprobe with libx264, Go, uv. Every process it starts is stopped at the end, including the publisher, which MediaMTX starts in its own process group.

Smoke run (executed 2026-10-31, before the restaurant pivot, with the previous event taxonomy): a 20 s `testsrc2` 640×360 clip, `--detector mock` on a 15 fps camera, with a GT containing one placeholder event. Result: 286 observations, first observation 2.83 s before frame 0. The replay produced 3 state changes and 0 incidents. The report was **NO-GO**: the event was missed (correct, since a test pattern has no people), and the blockers were MOCK input, unlocked GT, a single annotator and insufficient n. This exercised the plumbing only and says nothing about accuracy. The pipeline has not been re-run since the pivot.
