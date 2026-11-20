# ADR-006: Three processes + Postgres; no Redis, broker or Kubernetes in MVP
**Status:** Accepted (amended 2026-11-20) · **Date:** 2026-10-27

## Decision
`vision-worker` (Python) · `core` (Go: engine, incidents, alerts, API, analytics, access log, audit, retention; serves the `web` static export) · PostgreSQL. Docker Compose/systemd.

## Amendment (2026-11-20): transport as built
The original plan of gRPC over a UNIX socket was **replaced** by NDJSON over HTTP with a shared bearer token (`ZEOATAP_INTERNAL_TOKEN`) on a loopback listener:
- vision → core `POST /internal/v1/observations` (127.0.0.1:8090)
- POS connector → core `POST /internal/v1/pos-events` (same listener, ADR-010)
- core → vision `POST /v1/clips` (127.0.0.1:8081)

Responses report `accepted`/`ignored` and, on error or backlog (`503`), the first unprocessed `line`, so senders resend from there. NDJSON is streamable, easy to replay from files in tests, and needs no code generation.

## Triggers to revisit
NATS JetStream when there are ≥ 2 independent observation consumers or several GPU nodes per site; Kubernetes only for a multi-tenant cloud plane; Redis only for a measured need.

## Why
Each extra stateful service is another thing to secure and monitor on a single box in a restaurant back office.
