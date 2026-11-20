# Testing Strategy

**Date:** 2026-11-20

## 1. Test levels

| Level | Scope | Tools | Runs |
|---|---|---|---|
| Unit | Each rule (trigger, duration, business-hours gating, staff exclusion, INCONCLUSIVE on health loss); staff inference; schedule incl. overnight and DST; count_line direction; access-log visits; POS dedupe and −20 s/+5 s window; RBAC; retention; audit chain | Go `testing`, pytest, Vitest | Every commit |
| Contract | Observation schema; POSEvent NDJSON; API.md shapes and status codes | JSON Schema, Go API tests | Every commit |
| Integration | core + Postgres (ingest → incident → clip → playback); worker + RTSP simulator | `go test -race`, MediaMTX | Every PR |
| Replay | Recorded/synthetic observation + POS streams → `cmd/replay` → incidents vs. golden files | replay CLI, tools/eval | Nightly |
| E2E UI | Overview, exception queue, incident detail, dispositions, traffic heat map, access log, admin, role visibility (SHADOW hidden from staff/manager) | Playwright against mock API; smoke against real core | Pre-release |
| Load / soak | N cameras at 15/5 fps; POS burst; engine backlog `503` + resend | tools/soak | Weekly / pre-release |
| Security | RBAC matrix, admin cannot fetch clips, clip token expiry and reuse, login throttling `429`, CSRF `415`, session end on role change, webhook URL never in errors, internal endpoints reject missing/wrong token | Go tests, ZAP later | Per PR |
| Accuracy | Event-level metrics per [SAFETY_VALIDATION](SAFETY_VALIDATION.md) | tools/eval | Per release / pilot |

## 2. Golden scenarios (synthetic or staged with consent)

Empty restaurant after close; person enters after close (lights on/off); staff behind counter vs. customer in front; queue builds to 5 for 60 s; one guest waits 8 min; register post empty 3 min while open; refund with and without a customer at the counter; no-sale; duplicate POS event id; POS event for unknown register; person crouching/kneeling/sitting on floor (hard negatives for `person_down`); lens covered; camera unplugged; visitor walking in vs. out across the door line; cooler visit by staff vs. non-staff.

## 3. Failure injection

| Fault | Injection | Expected |
|---|---|---|
| Camera disconnect | Stop RTSP | CAMERA_UNAVAILABLE after > 3 s; `camera_tamper` after 30 s; never green |
| Lens covered / frozen / black | Synthetic frames | VIDEO_DEGRADED; `camera_tamper` after 30 s |
| Worker crash | kill -9 | AI_UNAVAILABLE / stale → not green; restart |
| Engine backlog | Flood observations | `503` with `line`; sender resumes from `line`; no loss, no duplicates |
| Bad NDJSON line | Malformed line N | `400` with `line` = N; earlier lines accepted |
| POS resend | Same ids twice | Second copy ignored |
| POS clock skew | Shift `ts` ±10 s | Documented false-positive behaviour; skew alarm (roadmap) |
| DB down | Stop Postgres | `/readyz` 503; overview `database: error` |
| Audit write fails | Fault DB | Clip media `503`; no unaudited playback |
| Webhook 500 / timeout | Mock relay | Retries; `alert_delivery_failed` with short class only; `alerts_health.failed` |
| Disk full in vault | Fill | `clip_failed`; `evidence: error` |
| Retention | Advance clock | Clip deleted; media `410`; held clip kept |

## 4. Executed

| Suite | Command | Result |
|---|---|---|
| Core (engine, store, evidence, alerts, server API/RBAC/e2e) | `cd services/core && go test -race ./...` | see README |
| vision-worker | `cd services/vision-worker && uv run pytest -q` | see README |
| Dashboard | `cd apps/web && npx tsc --noEmit && npx eslint . && npx next build && node e2e/run.mjs` | see README |
| Eval harness | `cd tools/eval && uv run pytest -q` | see README |
| Soak tooling | `cd tools/soak && uv run pytest -q` | see README |
| GPU inference benchmark | [BENCHMARK_RESULTS](BENCHMARK_RESULTS.md) | speed only |

All inputs are synthetic. **No real restaurant camera, POS feed or accuracy measurement yet.**
