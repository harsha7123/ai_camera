# Zeoatap Restaurant Watchdog: AI layer for restaurant CCTV

An edge AI layer for a restaurant's **existing** CCTV cameras. It watches the authorised feeds like a loss-prevention officer, links what it sees to **POS events**, and sends the owner and managers two kinds of output:
- **alerts**: something is happening now, such as an after-hours intrusion, a covered camera or a long line;
- **review items with a clip**: no-sale drawer opens, refunds with nobody at the counter, a person who may have fallen.

It also counts foot traffic, shows peak hours, and keeps an access log for the safe, cash office, walk-in cooler and back door.

> ⚠️ **AI flags, humans decide.** An alert is a prompt to review a clip, never a finding about a person. No discipline, police report or pay deduction may be based on an alert alone.
>
> **What has and hasn't been tested:**
> - No detection rule has been validated on real restaurant footage.
> - Alert rules start in **SHADOW**: they are recorded for the owner, and nobody is paged.
> - The owner turns real alerts on per rule after a 30–60 day tuning period.
> - Video only. Audio is never recorded. No face recognition or other biometrics.
> - This is not legal advice. Confirm notice, consent and monitoring rules with counsel in each state before go-live.

Requirements come from the owner's *AI CCTV Watchdog Use-Case Playbook* (60 checks, families A–H) and an industry-themes note. They are mapped item by item in [PRODUCT_REQUIREMENTS](docs/PRODUCT_REQUIREMENTS.md).

## What it does today

| Playbook check | Event / output | How | Default |
|---|---|---|---|
| G1 after-hours intrusion | `after_hours_intrusion` | A person on any camera outside business hours, plus the staff allowance before opening and after closing | alert, SHADOW until enabled |
| G3 camera tampering | `camera_tamper` | Camera offline, or video black, obstructed or frozen, for 30 s or more | alert, SHADOW until enabled |
| D5 / G4 cooler, safe, office | `restricted_zone_entry` + **access log** | Every visit to a `secure` zone is logged as staff or person. A person not recognised as staff in a `restricted`/`secure` zone is flagged | review |
| F6 slip / trip / fall | `person_down` | Box stays lying-down shaped in a `floor` zone for 3 s or more (heuristic) | alert, SHADOW until enabled |
| A4 queue length / wait | `long_queue`, `long_wait` | 5 or more people in a `queue` zone for 60 s; one person waiting 8 min or more | alert / review |
| B4 unattended post | `unattended_post` | Register or host stand (`post` zone) empty for 3 min or more while open | alert, SHADOW until enabled |
| C1 no-sale drawer opens | `pos_no_sale` | Every POS `no_sale` event, with a clip from the register camera | review |
| C3 refunds/voids with no customer | `pos_refund_no_customer` | POS `void`/`refund`/`comp` while nobody was in the register's `customer_side` zone from 20 s before to 5 s after | alert, SHADOW until enabled |
| A1 / A2 foot traffic, peak hours | traffic analytics | Entries and exits across a door `count_line`, plus peak occupancy, in 15-minute buckets. Shown as a day × hour heat map | — |
| E7 / H4 chargeback, complaint lookup | `?pos_ref=` search | Incidents tied to a POS ticket | — |

Everything else in the playbook (fire/smoke, weapons, PPE, hand-washing, dine-and-dash, sweethearting, time-clock reconciliation, daily and weekly reports) is in [FEATURE_ROADMAP](docs/FEATURE_ROADMAP.md), with what each one needs (new models, POS line items, time-clock integration).

**Staff vs. customer without faces.** The worker reports every detection as an anonymous `person`. Core marks a track as **staff** if it has spent 5 s or more in a `staff_area`/`post` zone (behind the counter), or if it is on a `staff_only` camera (kitchen, back of house). Nobody is identified. Identity for POS and the time clock comes only from those systems' own IDs ([ADR-003](docs/architecture/adr/ADR-003-no-biometric-identity.md)).

## Status (2026-11-20)

| Component | Status |
|---|---|
| Event engine: track, zone, health and POS rules; staff inference; business hours; traffic counting; access log; dedup and merge; idempotent replay | **Implemented and tested** (Go unit tests + a fixture replay test) |
| Core service: staff API with RBAC (staff, manager, owner, admin), login throttling, live updates (SSE), alerts with retries and escalation, encrypted evidence clips, retention and legal hold, hash-chained audit log, POS ingest, Postgres | **Implemented and tested** against Postgres (`go test -race`), including end-to-end ingest → incident → clip playback. Not load-tested |
| Vision worker: RTSP ingest, reconnect, quality checks, rolling buffer, clip cutting, YOLOX person detection, tracker | **Implemented and tested** on synthetic RTSP. **No real IP camera tested yet.** CPU is too slow for production (≈2 fps); needs a GPU |
| Staff dashboard (Next.js): overview, exception queue, clips, dispositions, traffic heat map, access log, admin | **Implemented and tested** with Playwright e2e tests against a mock API |
| Accuracy evaluation harness (event-level, Clopper-Pearson / exact Poisson) | **Implemented and tested.** **Waiting for annotated restaurant footage** |
| Multi-camera soak test | Run on the pre-pivot pipeline with synthetic cameras ([tools/soak/RESULTS.md](tools/soak/RESULTS.md)) |
| GPU inference benchmark | Run on an RTX PRO 4500 Blackwell with synthetic inputs, speed only ([BENCHMARK_RESULTS](docs/BENCHMARK_RESULTS.md)) |
| POS connectors (Toast, Square, Clover…), time clock, mobile push/SMS, MFA, multi-site cloud dashboard | **Not implemented**: the POS ingest API exists, vendor adapters do not |

**Test results (2026-11-20):**

| Suite | Result |
|---|---|
| Go core (`go test -race`, against Postgres 16) | 77 passed, 0 skipped |
| Vision worker | 63 passed; 9 skipped (live MediaMTX and model smoke tests need local binaries and weights) |
| Eval harness | 57 passed |
| Soak tool | 7 passed |
| Dashboard | `tsc`, `eslint` and `next build` clean; 35/35 Playwright e2e passed |

## Architecture in one paragraph
Edge-first ([ADR-001](docs/architecture/adr/ADR-001-edge-first-hybrid.md)): one appliance per restaurant runs four parts, and video never leaves the site.
- **`vision-worker`** (Python): RTSP → decode → person detection → tracking → anonymous *observations*.
- **`core`** (Go): event engine → incidents, access log, traffic → alerts, API, SSE, audit, retention. It also ingests POS events from a connector on the appliance.
- **`web`**: Next.js static export, served by core.
- **PostgreSQL**.

Detectors *observe*, rules *decide*, the alerter *delivers*, managers *judge* ([ADR-002](docs/architecture/adr/ADR-002-observation-decision-separation.md)). POS events are first-class evidence ([ADR-010](docs/architecture/adr/ADR-010-pos-integration.md)). See [SYSTEM_ARCHITECTURE](docs/SYSTEM_ARCHITECTURE.md).

## Quick start

Requires Go ≥ 1.24.
```bash
cd services/core
go test ./...                                   # engine, auth, evidence, replay fixture (DB tests skip without Postgres)
go run ./cmd/replay -config site.example.json \
    -observations ../../tests/fixtures/mock_observations.jsonl \
    -pos ../../tests/fixtures/mock_pos.jsonl
```
The fixture is a **synthetic MOCK** shift at "Harbor Grill" ([generate_mock.py](tests/fixtures/generate_mock.py)). The replay prints a `WARNING`, and every incident is marked `"source":"MOCK"` or `"POS"`. Expected outcome:
- a `restricted_zone_entry` and a `pos_no_sale` in review;
- a `person_down` and a `pos_refund_no_customer` in SHADOW;
- one staff visit to the walk-in cooler;
- 2 entries and 1 exit at the front door.

Database-backed tests:
```bash
ZEOATAP_TEST_DATABASE_URL=postgres://user@localhost:5432/postgres?sslmode=disable go test -race ./...
```

Vision worker (Python ≥ 3.12, [uv](https://github.com/astral-sh/uv), ffmpeg):
```bash
cd services/vision-worker
uv run pytest -q
uv run zeoatap-vision --config cameras.example.json --detector none
```

Dashboard (Node 22):
```bash
cd apps/web
npm ci && npm run build && npm run test:e2e        # e2e runs the static export against mock/server.mjs
```

### Running core
```bash
export DATABASE_URL=postgres://...  ZEOATAP_INTERNAL_TOKEN=$(openssl rand -hex 24)
export ZEOATAP_MASTER_KEY_FILE=/etc/zeoatap/master.key   # 32 bytes, chmod 600
export ZEOATAP_BOOTSTRAP_ADMIN='admin:<long password>'   # first start only
go run ./cmd/core -site site.example.json -web ../../apps/web/out
```
To turn on real alerts for a rule after tuning, set `"alerting_enabled": true` for that rule in the site config. Core writes the list of alerting rules to the audit log on every start ([ADR-008](docs/architecture/adr/ADR-008-event-level-validation-gates.md)).

A POS connector posts NDJSON to `POST /internal/v1/pos-events` on the loopback listener ([API.md](packages/contracts/API.md)). No card data is accepted.

## Security and privacy

| Area | Built in |
|---|---|
| Accounts | bcrypt (cost 12), 15-minute idle sessions, HttpOnly + `SameSite=Strict` + `Secure` cookies, JSON-only POSTs as the CSRF defence. Login throttling: 5 failures per username or 30 per IP in 15 min → 15 min lock (`429`) |
| Roles | staff (acknowledge only), manager (+ clips, dispositions, traffic, access log), owner (+ SHADOW, legal hold), admin (configuration; **cannot watch clips**). Disabling a user ends their sessions immediately |
| Evidence | A per-clip AES-256-GCM key, wrapped by a master key. Clips are never overwritten; files are fsynced. Clip links last 5 minutes; every view is audit-logged; deletion at retention destroys the key (crypto-shred); legal hold prevents deletion |
| Audit | Append-only, hash-chained log. UPDATE, DELETE and TRUNCATE are blocked by triggers. Chain verified on `/audit` |
| Web | CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, Permissions-Policy. Safe post-login redirects |
| Internal APIs | Loopback-only listener with a bearer token compared in constant time. Strict NDJSON schemas. Webhook and clip errors reach clients only as short classes, never URLs |
| Privacy | No audio, no face recognition, no cross-visit re-identification. Cameras are never placed in restrooms, changing rooms, locker areas or break rooms. Every camera has a written authorization record. See [PRIVACY_SECURITY_COMPLIANCE](docs/PRIVACY_SECURITY_COMPLIANCE.md) for posted notice and employee acknowledgment, NLRA §7, BIPA, and PCI (overhead POS cameras must not capture card numbers or PIN pads) |

Not yet: MFA, TLS termination guidance on the appliance, external anchoring of the audit chain, and per-request streaming decryption of large clips.

## Repository layout
```
docs/                      Requirements, architecture, AI strategy, validation, privacy, cost, roadmap
docs/architecture/adr/     Architecture decision records (ADR-009 restaurant pivot, ADR-010 POS)
docs/architecture/diagrams Mermaid diagrams
packages/contracts/        API contract (v2) and observation JSON Schema
services/core/             Go event engine, API, evidence vault, replay CLI; site.example.json
services/vision-worker/    Python camera ingest, person detection and tracking, clip buffer, GPU benchmark
apps/web/                  Next.js staff dashboard (static export served by core) + mock API + e2e
tools/eval/                Event-level accuracy evaluation harness
tools/soak/                Multi-camera soak/stress test
tests/fixtures/            MOCK observation and POS streams for replay
```

## Documentation
| Doc | Purpose |
|---|---|
| [PRODUCT_REQUIREMENTS](docs/PRODUCT_REQUIREMENTS.md) | Personas, stories, the 60-check playbook mapped to status, reports, dashboard |
| [SYSTEM_ARCHITECTURE](docs/SYSTEM_ARCHITECTURE.md) | Services, data flow, POS path, failure handling, network, camera placement |
| [AI_MODEL_STRATEGY](docs/AI_MODEL_STRATEGY.md) | Event taxonomy, rule logic and thresholds, failure modes, model roadmap |
| [SAFETY_VALIDATION](docs/SAFETY_VALIDATION.md) | Accuracy and validation plan: metrics, shadow period, enable criteria |
| [PRIVACY_SECURITY_COMPLIANCE](docs/PRIVACY_SECURITY_COMPLIANCE.md) | Threat model, RBAC, retention, employee-monitoring law checklist |
| [COST_AND_DEPLOYMENT](docs/COST_AND_DEPLOYMENT.md) | Formulas and restaurant scenarios |
| [FEATURE_ROADMAP](docs/FEATURE_ROADMAP.md) / [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) | Pilot → POS → tune and expand → prove ROI |
| [HURDLES_AND_RISKS](docs/HURDLES_AND_RISKS.md) / [OPEN_QUESTIONS](docs/OPEN_QUESTIONS.md) | Risks and unresolved decisions |
| [LICENSING_REGISTER](docs/LICENSING_REGISTER.md) | Licences for every component |
| [TESTING_STRATEGY](docs/TESTING_STRATEGY.md) / [BENCHMARK_RESULTS](docs/BENCHMARK_RESULTS.md) | Test levels; GPU speed numbers |

## Recommended hardware (provisional)
- **Appliance:** x86-64 with an NVIDIA GPU (16 GB VRAM or more), 32 GB RAM, 1 TB NVMe, TPM 2.0.
- **Cameras:** wired PoE on a VLAN **separate from guest Wi-Fi and from the POS network**.
- **Per site:**
  - a 360° dome per open floor;
  - an overhead camera per register;
  - kitchen wide view, back door, walk-in cooler, safe and entrance.
- **After hours:** IR-capable cameras. A very dark, featureless scene can be classed as obstructed and pause analysis, so tune the quality thresholds at install.

The benchmark gives ≈46 cameras per GPU of inference capacity (YOLOX-M, TensorRT FP16). That is an upper bound: the worker doesn't use TensorRT FP16 or batching yet.

## Known limitations
- **Accuracy:** nothing is trained or validated on restaurant footage.
- **Staff vs. customer:** inference is zone-based and will misjudge some cases, such as a customer leaning over the counter or a new hire who hasn't been behind the counter yet.
- **`person_down`:** a box-shape heuristic. Someone sitting or crouching on the floor also triggers it.
- **Traffic counts:** door crossings, not unique visitors.
- **POS rules:** depend on the POS and appliance clocks being in sync (NTP).
- **Legal review:** not done.
