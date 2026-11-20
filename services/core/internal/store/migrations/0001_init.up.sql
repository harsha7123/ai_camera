-- Core schema for one restaurant site's edge appliance. A "room" is an area
-- of the restaurant (dining room, front counter, kitchen, back of house).

CREATE TABLE facilities (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id           text PRIMARY KEY,
  facility_id  text NOT NULL REFERENCES facilities(id),
  name         text NOT NULL
);

CREATE TABLE cameras (
  id                  text PRIMARY KEY,
  room_id             text NOT NULL REFERENCES rooms(id),
  name                text NOT NULL,
  priority            boolean NOT NULL DEFAULT false,  -- register/POS camera, analysed at 15 fps
  staff_only          boolean NOT NULL DEFAULT false,  -- kitchen/back of house: everyone seen is staff
  zones               jsonb NOT NULL DEFAULT '[]',
  -- Written authorization record. A camera cannot exist without one.
  authorized_by       text NOT NULL CHECK (authorized_by <> ''),
  authorized_at       date NOT NULL,
  authorization_scope text NOT NULL CHECK (authorization_scope <> ''),
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE camera_states (
  camera_id  text PRIMARY KEY REFERENCES cameras(id),
  state      text NOT NULL,
  since      timestamptz NOT NULL
);

CREATE TABLE users (
  id             bigserial PRIMARY KEY,
  username       text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('staff','manager','owner','admin')),
  password_hash  text NOT NULL,
  disabled       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,               -- sha256 of the cookie value; the raw token is never stored
  user_id     bigint NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id                 text PRIMARY KEY,
  idempotency_key    text NOT NULL UNIQUE,    -- makes incident creation idempotent
  room_id            text NOT NULL,
  room_zone          text NOT NULL,
  event_type         text NOT NULL,
  family             text NOT NULL,
  start_ts           timestamptz NOT NULL,
  end_ts             timestamptz NOT NULL,
  cameras            text[] NOT NULL,
  status             text NOT NULL CHECK (status IN ('ALERTED','REVIEW_QUEUED','SHADOW','INCONCLUSIVE')),
  lifecycle          text NOT NULL DEFAULT 'new' CHECK (lifecycle IN ('new','acknowledged','resolved')),
  escalation_level   int NOT NULL DEFAULT 0,
  acknowledged_by    text,
  acknowledged_at    timestamptz,
  disposition        text CHECK (disposition IN ('ok','coach','investigate','false_detection','escalated_external','inconclusive')),
  resolved_by        text,
  resolved_at        timestamptz,
  rule_version       text NOT NULL,
  model_versions     jsonb NOT NULL DEFAULT '{}',
  source             text NOT NULL,
  detail             text NOT NULL DEFAULT '',
  pos_ref            text,                    -- POS ticket the incident is tied to (C1/C3, chargeback evidence)
  retention_deadline timestamptz NOT NULL,
  legal_hold         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_merge_idx ON incidents (room_id, room_zone, event_type, start_ts);
CREATE INDEX incidents_pos_ref_idx ON incidents (pos_ref) WHERE pos_ref IS NOT NULL;
CREATE INDEX incidents_open_idx ON incidents (lifecycle, created_at DESC);

CREATE TABLE incident_actions (
  id           bigserial PRIMARY KEY,
  incident_id  text NOT NULL REFERENCES incidents(id),
  actor        text NOT NULL,
  action       text NOT NULL CHECK (action IN ('acknowledged','disposition','escalated','note','hold_set','hold_released')),
  disposition  text,
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id               bigserial PRIMARY KEY,
  incident_id      text NOT NULL REFERENCES incidents(id),
  channel          text NOT NULL,             -- dashboard | webhook
  level            int NOT NULL DEFAULT 0,    -- escalation level that produced it
  state            text NOT NULL CHECK (state IN ('pending','delivered','failed')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text NOT NULL DEFAULT '',
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, channel, level)
);

CREATE TABLE evidence_clips (
  id            text PRIMARY KEY,
  incident_id   text NOT NULL REFERENCES incidents(id),
  camera_id     text NOT NULL,
  path          text NOT NULL,
  sha256        text NOT NULL,                -- of the plaintext clip
  size_bytes    bigint NOT NULL,
  wrapped_key   bytea,                        -- per-clip key wrapped by the master key; NULL once crypto-shredded
  partial       boolean NOT NULL DEFAULT false,
  start_ts      timestamptz NOT NULL,
  end_ts        timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (incident_id, camera_id)
);

-- Append-only, hash-chained audit log.
CREATE TABLE audit_log (
  seq        bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  subject    text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Every POS event received, for reconciliation and ticket search. No card data
-- is ever accepted (ADR-010).
CREATE TABLE pos_events (
  id            text PRIMARY KEY,               -- POS-assigned id; duplicates are ignored
  register_id   text NOT NULL,
  type          text NOT NULL CHECK (type IN ('sale','no_sale','void','refund','comp','discount')),
  ts            timestamptz NOT NULL,
  amount_cents  bigint,
  ticket_ref    text,
  employee_ref  text,                           -- the POS's own employee number, never derived from video
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_events_ts_idx ON pos_events (ts);
CREATE INDEX pos_events_ticket_idx ON pos_events (ticket_ref) WHERE ticket_ref IS NOT NULL;

-- Secure-zone access log (safe, cash office, walk-in cooler, back door).
-- Anonymous: a track id is never stored, only the inferred role.
CREATE TABLE zone_access (
  id           bigserial PRIMARY KEY,
  camera_id    text NOT NULL,
  room_id      text NOT NULL,
  room_zone    text NOT NULL,
  zone_id      text NOT NULL,
  role         text NOT NULL CHECK (role IN ('staff','person','customer')),
  start_ts     timestamptz NOT NULL,
  end_ts       timestamptz NOT NULL,
  after_hours  boolean NOT NULL,
  UNIQUE (camera_id, zone_id, start_ts)
);
CREATE INDEX zone_access_start_idx ON zone_access (start_ts DESC);

-- Foot traffic and occupancy in 15-minute buckets (aggregates only).
CREATE TABLE traffic_counts (
  camera_id       text NOT NULL,
  bucket_start    timestamptz NOT NULL,
  entries         int NOT NULL DEFAULT 0,
  exits           int NOT NULL DEFAULT 0,
  peak_occupancy  int NOT NULL DEFAULT 0,
  PRIMARY KEY (camera_id, bucket_start)
);
