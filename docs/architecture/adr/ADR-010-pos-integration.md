# ADR-010: POS events as first-class evidence
**Status:** Accepted · **Date:** 2026-11-20

## Context
Most cash-theft checks in the playbook (C1–C9) are "POS event + video at the register". Video alone cannot tell a refund from a sale; POS alone cannot tell whether a customer was there. POS vendors (Toast, Square, Clover and others) expose transactions through different APIs and partner programmes.

## Decision
- core accepts `POST /internal/v1/pos-events`: NDJSON, one `POSEvent` per line `{id, register_id, type ∈ sale|no_sale|void|refund|comp|discount, ts, amount_cents, ticket_ref, employee_ref}`, bearer token, internal listener only.
- A thin **connector per POS vendor** translates the vendor feed to POSEvent. Connectors live outside core.
- **Dedupe by `id`** (unique per POS, stable across resends); unknown `register_id` lines are ignored; on error or backlog the response's `line` tells the connector where to resume.
- Registers are mapped in site config to a camera, a `customer_side` zone and a room zone.
- `ticket_ref` becomes the incident's `pos_ref` (searchable); `employee_ref` is stored for matching only — identity never comes from video (ADR-003).
- **Clock sync is a requirement.** `pos_refund_no_customer` looks at −20 s … +5 s around `ts`; POS and edge clocks must agree within a few seconds (NTP on both; skew monitoring is roadmap).
- **PCI scope minimisation:** the contract has **no fields for card data** (PAN, expiry, track data, PIN, cardholder name). Connectors must drop such data before sending. The appliance is not meant to store, process or transmit cardholder data.

## Consequences
+ C1 and C3 work today given a connector; A3 conversion and C7 discount abuse have their data path.
− No connector is built yet; vendor API access and terms are open (OQ-B5). C4 under-ringing needs line items, which POSEvent v2 does not carry (a contract change).
− A silent connector means no POS incidents; POS feed health must be shown (roadmap).
