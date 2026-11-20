# Core API contract (v2, restaurant)

Single source of truth for:
- `services/core`, which implements it;
- `apps/web`, which consumes it;
- `services/vision-worker` and POS connectors, which use the internal endpoints.

Change this file first if the contract changes.

## Conventions
- **JSON everywhere.** Errors are `{"error": "human-readable message"}` with a proper status code.
- **CSRF defence.** Every staff `POST` must send `Content-Type: application/json`, otherwise the server returns `415`. Together with `SameSite=Strict` cookies, this is the CSRF defence. The internal streams use `application/x-ndjson`.
- **Staff auth.** An HttpOnly cookie `zeoatap_session` with a 15 min sliding idle timeout. `401` means not signed in; `403` means signed in but the role lacks permission.
- **Login throttling.** After 5 failed attempts for one username within 15 min, that username is locked for 15 min. After 30 failed attempts from one client IP within 15 min, that IP is locked. Both return `429` with a `Retry-After` header. While locked, failed attempts are not written to the audit log; the lock itself is audited once.
- **Times** are RFC 3339 UTC strings. Business hours are evaluated in the site's IANA timezone.
- **Naming.** A **room** is an area of the restaurant: dining room, counter, kitchen, back of house. The field names `room_id` and `room_zone` are kept from v1.

## Roles → permissions
| Permission | staff | manager | owner | admin |
|---|---|---|---|---|
| view_status (overview, incidents list/detail, events) | ✓ | ✓ | ✓ | ✓ |
| acknowledge | ✓ | ✓ | ✓ | ✓ |
| view_clips | | ✓ | ✓ | |
| disposition | | ✓ | ✓ | |
| view_analytics (traffic and peak hours) | | ✓ | ✓ | |
| view_access_log (secure-zone access log) | | ✓ | ✓ | |
| view_shadow (see SHADOW incidents) | | | ✓ | ✓ |
| legal_hold | | | ✓ | ✓ |
| admin (cameras, users, audit) | | | | ✓ |

Admins configure the system. They cannot watch clips: separation of duties.

## Event types
"AI flags, humans decide." An incident is a possible event for a manager to review, never a finding about a person.

| event_type | family | Playbook use case | Trigger | Default policy |
|---|---|---|---|---|
| `after_hours_intrusion` | G | G1 | A person is detected outside the staff window (business hours, plus the pre-open and post-close allowances) | alert |
| `camera_tamper` | G | G3 | The camera is VIDEO_DEGRADED (black, obstructed or frozen) or CAMERA_UNAVAILABLE for 30 s or more | alert |
| `restricted_zone_entry` | D | D5 / G4 | A person not recognised as staff is in a `restricted` or `secure` zone for 3 s or more | review |
| `person_down` | F | F6 | A person's box stays lying-down shaped (real width/height ≥ 1.3, using `frame_size`) in a `floor` zone for 3 s or more. Only cameras with a `floor` zone are evaluated; overhead and 360° cameras must not have one | alert |
| `long_queue` | A | A4 | `max_people` (default 5) or more people in a `queue` zone for 60 s or more, during business hours | alert |
| `long_wait` | A | A4 | One person stays in a `queue` zone for 8 min or more | review |
| `unattended_post` | B | B4 | A `post` zone (register, host stand, counter) has nobody in it for 3 min or more, during business hours | alert |
| `pos_no_sale` | C | C1 | The POS reports a `no_sale` drawer open | review |
| `pos_refund_no_customer` | C | C3 | A POS `void`, `refund` or `comp` happens while nobody was in the register's `customer_side` zone between 20 s before and 5 s after it | alert |

**Alert-policy rules start as `SHADOW`.** SHADOW incidents are visible only to owners and admins, and nobody is paged. The site owner turns real alerts on per rule after a tuning period, with `"alerting_enabled": true` in the site config. Every enabled rule is written to the audit log at startup. `INCONCLUSIVE` means the camera lost sight (or went degraded) before the rule could decide.

Not detectable yet; these need new models and are listed in `docs/FEATURE_ROADMAP.md`:
- fire and smoke (F7);
- weapons (F5);
- PPE and hand-washing (B9/B10);
- fights (F1);
- concealment (E1);
- dine-and-dash (E2);
- plate and pour counting (D2/D4/A8).

## Monitoring states (worst first)
`CAMERA_UNAVAILABLE` > `NOT_CONNECTED` > `AI_UNAVAILABLE` > `VIDEO_DEGRADED` > `FULLY_OPERATIONAL`.

- A room's state is the worst state among its cameras; a room with no cameras is `NOT_CONNECTED`.
- The site's state is the worst room.
- **Only `FULLY_OPERATIONAL` may be shown green.**

## Staff endpoints (public listener, default `:8080`)

| Method & path | Perm | Request | Response |
|---|---|---|---|
| `POST /api/v1/login` | — | `{username, password}` | `200 {user}` / `401` / `429` |
| `POST /api/v1/logout` | — | — | `204` |
| `GET /api/v1/me` | any | — | `{user, permissions: [..]}` |
| `GET /api/v1/overview` | view_status | — | Overview (below) |
| `GET /api/v1/cameras` | view_status | — | `[Camera]` |
| `POST /api/v1/cameras` | admin | Camera (authorization fields required) | `201 Camera` / `409` duplicate id |
| `GET /api/v1/incidents?open=1&shadow=1&pos_ref=…&limit=N` | view_status (`shadow=1` needs view_shadow, otherwise ignored) | — | `[Incident]`, newest first; `limit` ≤ 1000 |
| `GET /api/v1/incidents/{id}` | view_status (a SHADOW incident needs view_shadow, otherwise `404`) | — | Incident with `actions` and `clips` |
| `POST /api/v1/incidents/{id}/ack` | acknowledge | `{}` | `200 Incident` |
| `POST /api/v1/incidents/{id}/disposition` | disposition | `{disposition, note}` | `200 Incident` / `409` if already resolved |
| `POST /api/v1/incidents/{id}/hold` | legal_hold | `{hold: bool}` | `200 Incident` / `404` |
| `POST /api/v1/clips/{id}/token` | view_clips | `{}` | `{url, expires_at}`; `url` is `/api/v1/clips/{id}/media?token=…`, valid 5 min |
| `GET /api/v1/clips/{id}/media?token=…` | token | — | `video/mp4`, supports Range. `403` bad or expired token, `410` deleted under retention, `503` audit write failed. The first request for each token is audit-logged |
| `GET /api/v1/events` | view_status | — | `text/event-stream` (below) |
| `GET /api/v1/analytics/traffic?from=&to=` | view_analytics | — | Traffic (below). Defaults to the last 7 days; at most 92 days |
| `GET /api/v1/access-log?from=&to=&limit=N` | view_access_log | — | `[ZoneAccess]`, newest first. Defaults to the last 7 days; `limit` ≤ 1000 |
| `GET /api/v1/users` | admin | — | `[User]` |
| `POST /api/v1/users` | admin | `{username, display_name, role, password}` | `201 User` / `409` duplicate |
| `POST /api/v1/users/{id}` | admin | Any of `{display_name, role, disabled, password}` | `200 User`. Disabling a user, or changing their role or password, ends all their sessions. Admins cannot disable or demote themselves (`400`) |
| `GET /api/v1/audit?limit=N` | admin | — | `{entries: [AuditEntry], chain_ok: bool, broken_at: int}` |
| `GET /healthz` | — | — | `200 {"ok":true}` |
| `GET /readyz` | — | — | `200`, or `503` if the database or engine is unhealthy |

`disposition` ∈ `ok | coach | investigate | false_detection | escalated_external | inconclusive`. The playbook's shift exception queue is "manager marks OK / coach / investigate".

### Shapes
```jsonc
// User
{"id": 1, "username": "sam", "display_name": "Sam", "role": "manager", "disabled": false}

// Camera. Zone kinds: restricted | secure | staff_area | queue | post | customer_side | floor | count_line
{"id": "cam-counter", "room_id": "counter", "name": "Register 1 overhead", "priority": true, "staff_only": false,
 "zones": [{"id": "reg1-front", "room_zone": "register-1-front", "kind": "customer_side",
            "polygon": [{"X":0.1,"Y":0.6}, ...]}],
 "authorized_by": "Owner", "authorized_at": "2026-10-01", "authorization_scope": "Front counter, business hours and after-hours security",
 "enabled": true, "state": "FULLY_OPERATIONAL", "state_since": "2026-10-31T12:00:00Z"}

// Incident
{"id": "INC-392ecdca3371", "room_id": "counter", "room_zone": "register-1",
 "event_type": "pos_refund_no_customer", "family": "C", "start": "...", "end": "...", "cameras": ["cam-counter"],
 "status": "ALERTED | REVIEW_QUEUED | SHADOW | INCONCLUSIVE",
 "lifecycle": "new | acknowledged | resolved", "escalation_level": 0,
 "acknowledged_by": null, "acknowledged_at": null, "disposition": null, "resolved_by": null, "resolved_at": null,
 "rule_version": "c3-v0.1", "model_versions": {"detector": "..."}, "source": "MOCK | POS | <pipeline id>",
 "detail": "refund $42.10 on register 1 with nobody at the counter", "pos_ref": "T-1042",
 "created_at": "...", "retention_deadline": "...", "legal_hold": false,
 "actions": [{"actor": "sam", "action": "acknowledged", "disposition": null, "note": null, "at": "..."}],
 "clips": [{"id": "INC-…-cam-counter", "camera_id": "cam-counter", "sha256": "…", "size_bytes": 123, "partial": false,
            "start": "...", "end": "...", "created_at": "...", "deleted_at": null}]}

// Overview
{"facility": {"id": "harbor-grill", "name": "Harbor Grill"},
 "business": {"open": true, "timezone": "America/New_York", "today": [["11:00","22:00"]]},
 "state": "FULLY_OPERATIONAL",
 "rooms": [{"id": "counter", "name": "Front counter", "state": "...",
            "cameras": [{"id": "cam-counter", "name": "...", "state": "...", "since": "...", "priority": true}]}],
 "open_alerts": 1,
 "alerts_health": {"failed": 0, "delayed": 0},
 "services": {"engine": "ok | error", "engine_error": "", "database": "ok | error", "evidence": "ok | error"},
 "generated_at": "..."}

// Traffic (15-minute buckets; entries/exits come from count_line zones; peak_occupancy = most people seen at once on that camera)
{"timezone": "America/New_York", "bucket_minutes": 15, "from": "...", "to": "...",
 "buckets": [{"camera_id": "cam-entrance", "start": "2026-10-31T16:00:00Z", "entries": 12, "exits": 9, "peak_occupancy": 7}]}

// ZoneAccess (one visit by one tracked person to a secure zone: safe, cash office, walk-in cooler, back door)
{"id": 17, "camera_id": "cam-kitchen", "room_id": "kitchen", "room_zone": "walk-in-cooler", "zone_id": "cooler-door",
 "role": "staff | person", "start": "...", "end": "...", "after_hours": false}

// AuditEntry
{"seq": 12, "at": "...", "actor": "sam", "action": "clip_viewed", "subject": "INC-…-cam-counter", "payload": {}}
```

### Server-sent events (`GET /api/v1/events`)
- Each message is `event: <type>\ndata: <json>\n\n`, with a `: ping` comment every 15 s.
- Events are not replayed, so after a reconnect clients must re-fetch `/overview` and `/incidents`.

| type | data |
|---|---|
| `camera_state` | `{camera_id, state, since}` |
| `incident_created` / `incident_merged` / `incident_updated` | Incident |
| `alert` | `{incident_id, room_id, event_type, level}` |
| `incident_escalated` | `{incident_id, level}` |
| `alert_delivery_failed` | `{incident_id, channel, error}`. `error` is a short class (`timeout`, `connection failed`, `HTTP 500`) and never contains the webhook URL |
| `clip_ready` | `{incident_id, clip_id, partial}` |
| `clip_failed` | `{incident_id, camera_id, error}` (short class only) |

SHADOW incidents are never sent to clients without view_shadow.

## Internal endpoints (localhost only, `Authorization: Bearer $ZEOATAP_INTERNAL_TOKEN`)

| Direction | Method & path | Request | Response |
|---|---|---|---|
| vision → core (internal listener, default `127.0.0.1:8090`) | `POST /internal/v1/observations` | NDJSON body, one Observation per line ([observation.schema.json](observation.schema.json)), streamed | `200 {"accepted": n, "ignored": m}` · `400 {"error", "accepted", "ignored", "line"}` (`line` is the 0-based index of the bad line; lines after it are not read) · `503 {"error", "accepted", "ignored", "line"}` engine backlog full (`line` = first line not queued) |
| POS connector → core (internal listener) | `POST /internal/v1/pos-events` | NDJSON, one POSEvent per line | Same response shape as observations |
| core → vision (vision health server, default `127.0.0.1:8081`) | `POST /v1/clips` | `{camera_id, start, end, path}` (start and end are unix seconds, float) | `200 {path, sha256, partial}` · `404 {error}` unknown camera · `422 {error}` no video for the window. Blocks until the clip is written (≤ end + 120 s) |

- **Ignored lines.** An observation is ignored when it is for a camera core doesn't know. A POS event is ignored when its register is unknown, or when its `id` was already received (dedupe).
- **Resending.** Senders resend only the lines from `line` onwards.
- **Clips.** Core encrypts the plaintext clip from `path` into its vault and deletes the plaintext. Core never asks for the same incident/camera clip twice: an existing clip record is never overwritten.

```jsonc
// POSEvent. `id` must be unique per POS and stable across resends.
// type ∈ sale | no_sale | void | refund | comp | discount
{"id": "toast-8f2c…", "register_id": "reg1", "type": "refund", "ts": "2026-10-31T19:02:11Z",
 "amount_cents": 4210, "ticket_ref": "T-1042", "employee_ref": "E-17"}
```

`employee_ref` is the POS's own employee number, stored only for matching. Core never derives identity from video (ADR-003).
