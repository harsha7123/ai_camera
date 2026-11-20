#!/usr/bin/env node
// Zeoatap mock core API (v2, restaurant). Plain Node, no dependencies.
//
// Implements the staff endpoints of packages/contracts/API.md with seeded data
// for the example restaurant in services/core/site.example.json ("Harbor
// Grill"): every monitoring state, every incident status/lifecycle, POS-linked
// incidents with ticket refs, 15-minute traffic buckets, the secure-zone
// access log, user edits, login throttling and SSE. It can also serve the
// static export (default ./out) at "/", the same way the Go core does, so the
// dashboard and API share one origin.
//
//   node mock/server.mjs                     # :8080, serves ./out if present
//   PORT=8181 STATIC_DIR=out PING_MS=15000 node mock/server.mjs
//
// Seeded accounts (password for all: "zeoatap-demo"):
//   jo (staff) · sam (manager) · olivia (owner) · ada (admin) · former (staff, disabled)
//
// Clip media: a tiny H.264 MP4 generated with ffmpeg on first start into
// mock/fixtures/sample.mp4 (git-ignored: the repo never stores footage).
//
// Test-control endpoints (mock only, never part of the real contract):
//   POST /__mock/reset                  {scenario?: "default" | "all_ok"}
//   POST /__mock/scenario               {name: "default" | "all_ok" | "audit_broken"}
//   POST /__mock/camera_state           {camera_id, state}            -> emits camera_state
//   POST /__mock/incident               {room_id?, room_zone?, event_type?, status?, pos_ref?, cameras?, silent?}
//                                                                     -> creates + emits incident_created (+ alert if ALERTED)
//   POST /__mock/resolve                {id, disposition?, actor?}    -> resolves without broadcasting (409 tests)
//   POST /__mock/clip_delete            {id}                          -> marks a clip retention-deleted (media -> 410)
//   POST /__mock/audit_fail             {on}                          -> clip media returns 503 (audit write failure)
//   POST /__mock/services               {engine?, engine_error?, ...} -> overrides service health
//   POST /__mock/business               {open: bool | null}           -> overrides "open now" (null = from site hours)
//   POST /__mock/emit                   {type, data}                  -> raw SSE event
//   POST /__mock/sse/drop               {refuse_ms?: number}          -> closes streams, refuses reconnects for refuse_ms
//   POST /__mock/sse/stall              {}                            -> current streams stay open but go silent (no pings)
//   POST /__mock/sessions/expire        {}                            -> invalidates every session
//   POST /__mock/latency                {ms}                          -> adds latency before API responses
//   POST /__mock/incidents_delay        {ms}                          -> GET /incidents snapshots, then waits ms before replying
//   GET  /__mock/state                                                 -> debug dump

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const STATIC_DIR = path.resolve(process.cwd(), process.env.STATIC_DIR ?? "out");
const PING_MS = Number(process.env.PING_MS ?? 15000);
const SITE_FILE = path.resolve(HERE, process.env.SITE_FILE ?? "../../../services/core/site.example.json");
const IDLE_MS = 15 * 60 * 1000;
const PASSWORD = "zeoatap-demo";
const CLIP_FILE = path.join(HERE, "fixtures", "sample.mp4");
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const USER_FAIL_LIMIT = 5;
const IP_FAIL_LIMIT = 30;

const PERMS = {
  staff: ["view_status", "acknowledge"],
  manager: ["view_status", "acknowledge", "view_clips", "disposition", "view_analytics", "view_access_log"],
  owner: ["view_status", "acknowledge", "view_clips", "disposition", "view_analytics", "view_access_log", "view_shadow", "legal_hold"],
  admin: ["view_status", "acknowledge", "view_shadow", "legal_hold", "admin"],
};
const STATE_RANK = {
  CAMERA_UNAVAILABLE: 4,
  NOT_CONNECTED: 3,
  AI_UNAVAILABLE: 2,
  VIDEO_DEGRADED: 1,
  FULLY_OPERATIONAL: 0,
};
const DISPOSITIONS = ["ok", "coach", "investigate", "false_detection", "escalated_external", "inconclusive"];
const ZONE_KINDS = ["restricted", "secure", "staff_area", "queue", "post", "customer_side", "floor", "count_line"];
const FAMILY = {
  after_hours_intrusion: "G", camera_tamper: "G", restricted_zone_entry: "D", person_down: "F", long_queue: "A",
  long_wait: "A", unattended_post: "B", pos_no_sale: "C", pos_refund_no_customer: "C",
};
const RULE = {
  after_hours_intrusion: "g1-v0.1", camera_tamper: "g3-v0.1", restricted_zone_entry: "d5-v0.1", person_down: "f6-v0.1", long_queue: "a4-v0.1",
  long_wait: "a4w-v0.1", unattended_post: "b4-v0.1", pos_no_sale: "c1-v0.1", pos_refund_no_customer: "c3-v0.1",
};

const SITE = JSON.parse(fs.readFileSync(SITE_FILE, "utf8"));
const TZ = SITE.business_hours.timezone;

// ---------------------------------------------------------------- clip fixture
function ensureClip() {
  if (fs.existsSync(CLIP_FILE) && fs.statSync(CLIP_FILE).size > 0) return true;
  fs.mkdirSync(path.dirname(CLIP_FILE), { recursive: true });
  const tmp = `${CLIP_FILE}.${process.pid}.tmp.mp4`;
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", "3", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tmp],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    console.warn(`mock: could not generate ${CLIP_FILE} with ffmpeg (${r.error?.message ?? String(r.stderr ?? "").trim()}); clip media will return 500`);
    return false;
  }
  fs.renameSync(tmp, CLIP_FILE); // atomic: concurrent mocks never see a half-written file
  return true;
}
const CLIP_OK = ensureClip();

// ---------------------------------------------------------------- site time
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function local(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: Number(o.year), mo: Number(o.month), d: Number(o.day), wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(o.weekday),
    h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second),
  };
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const parseDur = (s) => (/^(\d+)m$/.exec(s ?? "") ? Number(/^(\d+)m$/.exec(s)[1]) : 0);
/** Local midnight (as an instant) of the site-local day containing ms, shifted by `days`. */
function localMidnight(ms, days = 0) {
  const p = local(ms);
  const guess = Date.UTC(p.y, p.mo - 1, p.d + days);
  const off = (t) => {
    const q = local(t);
    return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}
/** Within [open - before, close + after) of today's or yesterday's spans (site-local). */
function withinHours(ms, beforeMin = 0, afterMin = 0) {
  const p = local(ms);
  const m = p.h * 60 + p.mi;
  const today = SITE.business_hours.weekly[DAY_KEYS[p.wd]] ?? [];
  for (const [o, c] of today) if (m >= toMin(o) - beforeMin && m < toMin(c) + afterMin) return true;
  const yday = SITE.business_hours.weekly[DAY_KEYS[(p.wd + 6) % 7]] ?? [];
  for (const [, c] of yday) if (toMin(c) + afterMin > 1440 && m < toMin(c) + afterMin - 1440) return true;
  return false;
}
const isOpen = (ms) => withinHours(ms);
const isStaffWindow = (ms) => withinHours(ms, parseDur(SITE.business_hours.staff_before_open), parseDur(SITE.business_hours.staff_after_close));

// ---------------------------------------------------------------- state
let db;
let sessions = new Map(); // token -> {userId, lastSeen}
let tokens = new Map(); // clip token -> {clipId, expires, actor, used}
let sseClients = new Set(); // {res, user, tok, stalled}
let sseConnects = 0;
let refuseSseUntil = 0;
let latencyMs = 0;
let incidentsDelayMs = 0;
let loginFails = new Map(); // "u:<name>" | "ip:<addr>" -> {times: [], lockedUntil, lockAudited}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function seed(scenario = "default") {
  const allOk = scenario === "all_ok";
  const states = allOk
    ? {}
    : { "cam-counter": ["VIDEO_DEGRADED", 4 * MIN], "cam-dining": ["CAMERA_UNAVAILABLE", 2 * MIN], "cam-kitchen": ["AI_UNAVAILABLE", 7 * MIN] };
  const cams = SITE.cameras.map((c) => {
    const [state, ago] = states[c.id] ?? ["FULLY_OPERATIONAL", 3 * 60 * MIN];
    return {
      id: c.id, room_id: c.room_id, name: c.name, priority: !!c.priority, staff_only: !!c.staff_only, zones: c.zones,
      authorized_by: c.authorized_by, authorized_at: c.authorized_at, authorization_scope: c.authorization_scope,
      enabled: c.enabled !== false, state, state_since: iso(ago),
    };
  });
  const rooms = SITE.rooms.map((r) => ({ ...r }));
  if (!allOk) rooms.push({ id: "patio", name: "Patio" }); // no cameras -> NOT_CONNECTED

  const users = [
    { id: 1, username: "jo", display_name: "Jo Rivera", role: "staff", disabled: false },
    { id: 2, username: "sam", display_name: "Sam Lee", role: "manager", disabled: false },
    { id: 3, username: "olivia", display_name: "Olivia Grant", role: "owner", disabled: false },
    { id: 4, username: "ada", display_name: "Ada Mensah", role: "admin", disabled: false },
    { id: 5, username: "former", display_name: "Former Staff", role: "staff", disabled: true },
  ];

  const incidents = allOk
    ? []
    : [
        incident({
          id: "INC-7f3a9c21b001", room_id: "counter", room_zone: "register-1", event_type: "pos_refund_no_customer",
          agoStart: 50_000, cameras: ["cam-counter", "cam-entrance"], status: "ALERTED", lifecycle: "new", source: "POS", pos_ref: "T-1042",
          detail: "Refund $42.10 on Register 1 with nobody seen at the counter from 20 s before to 5 s after. View partly degraded.",
          uncertainty: "medium", visibility: "partial (counter camera video degraded)",
        }),
        incident({
          id: "INC-2b8e44d0c002", room_id: "back", room_zone: "back-door", event_type: "after_hours_intrusion",
          agoStart: 14 * MIN, cameras: ["cam-back"], status: "ALERTED", lifecycle: "acknowledged", escalation_level: 1,
          acknowledged_by: "sam", acknowledged_at: iso(13 * MIN),
          detail: "Person detected at the back door outside the staff window for 6 s.",
          actions: [{ actor: "system", action: "escalated", disposition: null, note: "level 1", at: iso(13.5 * MIN) }, { actor: "sam", action: "acknowledged", disposition: null, note: null, at: iso(13 * MIN) }],
        }),
        incident({
          id: "INC-91c0de55a003", room_id: "kitchen", room_zone: "walk-in-cooler", event_type: "restricted_zone_entry",
          agoStart: 42 * MIN, cameras: ["cam-kitchen"], status: "REVIEW_QUEUED", lifecycle: "acknowledged",
          acknowledged_by: "jo", acknowledged_at: iso(40 * MIN),
          detail: "A person not recognised as staff was in the walk-in cooler door zone for 4 s. Evidence quality low; review required.",
          uncertainty: "high", visibility: "good",
          actions: [{ actor: "jo", action: "acknowledged", disposition: null, note: null, at: iso(40 * MIN) }],
        }),
        incident({
          id: "INC-4d2f11e9b004", room_id: "dining", room_zone: "dining-floor", event_type: "camera_tamper",
          agoStart: 3 * 60 * MIN, cameras: ["cam-dining"], status: "INCONCLUSIVE", lifecycle: "resolved",
          acknowledged_by: "jo", acknowledged_at: iso(179 * MIN), disposition: "inconclusive", resolved_by: "olivia",
          resolved_at: iso(150 * MIN), legal_hold: true,
          detail: "Dining room camera view went black for 41 s.",
          actions: [
            { actor: "jo", action: "acknowledged", disposition: null, note: null, at: iso(179 * MIN) },
            { actor: "olivia", action: "disposition", disposition: "inconclusive", note: "A coat was hung over the camera bracket. Asked staff to keep it clear.", at: iso(150 * MIN) },
            { actor: "olivia", action: "legal_hold_set", disposition: null, note: null, at: iso(149 * MIN) },
          ],
        }),
        incident({
          id: "INC-c05e7a8fd005", room_id: "dining", room_zone: "dining-floor", event_type: "person_down",
          agoStart: 25 * MIN, cameras: ["cam-dining"], status: "SHADOW", lifecycle: "new",
          rule_version: "f6-v0.0.3-shadow",
          detail: "Shadow-mode rule (being tuned; nobody alerted). Lying-down shaped box on the dining floor for 3.4 s.",
        }),
        incident({
          id: "INC-e1aa0b77c006", room_id: "counter", room_zone: "register-1", event_type: "pos_no_sale",
          agoStart: 26 * 60 * MIN, cameras: ["cam-counter"], status: "REVIEW_QUEUED", lifecycle: "resolved", source: "POS", pos_ref: "T-0988",
          acknowledged_by: "jo", acknowledged_at: iso(26 * 60 * MIN - 20_000), disposition: "ok",
          resolved_by: "sam", resolved_at: iso(25 * 60 * MIN), clipsDeleted: true,
          detail: "No-sale drawer open on Register 1.",
          actions: [
            { actor: "jo", action: "acknowledged", disposition: null, note: null, at: iso(26 * 60 * MIN - 20_000) },
            { actor: "sam", action: "disposition", disposition: "ok", note: "Change for the tip jar, logged on the shift sheet.", at: iso(25 * 60 * MIN) },
          ],
        }),
        incident({
          id: "INC-3c9d2e10a007", room_id: "counter", room_zone: "counter-queue", event_type: "long_queue",
          agoStart: 5 * 60 * MIN, cameras: ["cam-counter"], status: "ALERTED", lifecycle: "resolved",
          acknowledged_by: "jo", acknowledged_at: iso(5 * 60 * MIN - 30_000), disposition: "ok", resolved_by: "sam", resolved_at: iso(4 * 60 * MIN),
          detail: "6 people in the counter queue for 75 s during the lunch rush.",
          actions: [
            { actor: "jo", action: "acknowledged", disposition: null, note: null, at: iso(5 * 60 * MIN - 30_000) },
            { actor: "sam", action: "disposition", disposition: "ok", note: "Opened the second register.", at: iso(4 * 60 * MIN) },
          ],
        }),
      ];

  db = {
    scenario,
    facility: SITE.facility,
    rooms,
    cameras: cams,
    users,
    incidents,
    audit: [],
    accessLog: seedAccessLog(),
    nextUserId: 6,
    businessOverride: null,
    alerts_health: allOk ? { failed: 0, delayed: 0 } : { failed: 1, delayed: 2 },
    services: allOk
      ? { engine: "ok", engine_error: "", database: "ok", evidence: "ok" }
      : { engine: "ok", engine_error: "", database: "ok", evidence: "error" },
    auditBroken: scenario === "audit_broken",
  };
  for (const r of SITE_RULES_AUDIT()) addAudit("system", "rule_alerting_enabled", r, {}, 10 * 60 * MIN);
  const seedAudit = [
    ["system", "camera_registered", "cam-counter"], ["system", "camera_registered", "cam-kitchen"], ["ada", "user_created", "olivia"],
    ["jo", "login", "jo"], ["jo", "incident_acknowledged", "INC-4d2f11e9b004"], ["olivia", "clip_viewed", "INC-4d2f11e9b004-cam-dining"],
    ["olivia", "incident_disposition", "INC-4d2f11e9b004"], ["olivia", "legal_hold_set", "INC-4d2f11e9b004"], ["sam", "incident_acknowledged", "INC-2b8e44d0c002"],
  ];
  seedAudit.forEach(([actor, action, subject], i) => addAudit(actor, action, subject, {}, (seedAudit.length - i) * 7 * MIN));
}

function SITE_RULES_AUDIT() {
  return Object.entries(SITE.rules ?? {})
    .filter(([, r]) => r.policy === "alert" && r.alerting_enabled)
    .map(([k]) => k);
}

function incident(o) {
  const start = iso(o.agoStart);
  const end = iso(o.agoStart - 6000);
  const id = o.id;
  return {
    id, room_id: o.room_id, room_zone: o.room_zone, event_type: o.event_type, family: FAMILY[o.event_type] ?? "G",
    start, end, cameras: o.cameras, status: o.status, lifecycle: o.lifecycle, escalation_level: o.escalation_level ?? 0,
    acknowledged_by: o.acknowledged_by ?? null, acknowledged_at: o.acknowledged_at ?? null,
    disposition: o.disposition ?? null, resolved_by: o.resolved_by ?? null, resolved_at: o.resolved_at ?? null,
    rule_version: o.rule_version ?? RULE[o.event_type] ?? "x-v0.1",
    model_versions: { detector: "yolo-det-v0.3.1", tracker: "bytetrack-1.0" },
    source: o.source ?? "MOCK",
    detail: o.detail ?? "",
    pos_ref: o.pos_ref ?? null,
    ...(o.uncertainty ? { uncertainty: o.uncertainty } : {}),
    ...(o.visibility ? { visibility: o.visibility } : {}),
    created_at: start,
    retention_deadline: new Date(Date.now() - o.agoStart + 30 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"),
    legal_hold: o.legal_hold ?? false,
    actions: o.actions ?? [],
    clips: o.cameras.map((c, i) => ({
      id: `${id}-${c}`, camera_id: c, sha256: crypto.createHash("sha256").update(`${id}-${c}`).digest("hex"),
      size_bytes: CLIP_OK ? fs.statSync(CLIP_FILE).size : 0, partial: i === 1, start: iso(o.agoStart + 10_000), end: iso(o.agoStart - 16_000), created_at: end,
      deleted_at: o.clipsDeleted ? iso(o.agoStart - DAY) : null,
    })),
  };
}

// Secure-zone visits over the last 7 days at fixed site-local times.
function seedAccessLog() {
  const visits = [];
  const plan = [
    // [days ago, local hour (fractional), camera, room, room_zone, zone_id, role, seconds]
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((d) => [
      [d, 10.25, "cam-kitchen", "kitchen", "walk-in-cooler", "cooler-door", "staff", 95],
      [d, 14.66, "cam-kitchen", "kitchen", "walk-in-cooler", "cooler-door", "staff", 40],
      [d, 10.0, "cam-back", "back", "back-door", "back-door", "staff", 300],
      [d, 22.3, "cam-back", "back", "safe", "safe", "staff", 120],
    ]),
    [1, 23.85, "cam-back", "back", "safe", "safe", "staff", 75], // after the staff window on a weekday
    [2, 15.33, "cam-kitchen", "kitchen", "walk-in-cooler", "cooler-door", "person", 6],
    [3, 2.17, "cam-back", "back", "back-door", "back-door", "person", 18], // 02:10
  ];
  const now = Date.now();
  for (const [d, h, camera_id, room_id, room_zone, zone_id, role, secs] of plan) {
    const start = localMidnight(now, -d) + Math.round(h * 3600_000);
    if (start >= now - 60_000) continue;
    visits.push({ camera_id, room_id, room_zone, zone_id, role, start: isoAt(start), end: isoAt(start + secs * 1000), after_hours: !isStaffWindow(start), _t: start });
  }
  visits.sort((a, b) => b._t - a._t);
  return visits.map((v, i) => {
    const { _t, ...rest } = v;
    void _t;
    return { id: visits.length - i, ...rest };
  });
}

// Deterministic 15-minute traffic: a lunch and a dinner peak, busier at the
// weekend, counted only while open. Saturday 19:00 is the busiest slot.
function trafficBuckets(fromMs, toMs) {
  const STEP = 15 * MIN;
  const out = [];
  const now = Date.now();
  const dayFactor = [1, 1, 1, 1.05, 1.2, 1.45, 1.1];
  for (let t = Math.ceil(fromMs / STEP) * STEP; t < Math.min(toMs, now); t += STEP) {
    if (!isOpen(t)) continue;
    const p = local(t);
    const hr = p.h + p.mi / 60 + 0.125;
    const g = (mu, sd, amp) => amp * Math.exp(-((hr - mu) ** 2) / (2 * sd * sd));
    const base = (3 + g(12.5, 0.9, 12) + g(19.4, 1.0, 16)) * dayFactor[p.wd];
    const noise = crypto.createHash("md5").update(String(t)).digest()[0] % 3;
    const entries = Math.max(0, Math.round(base + noise - 1));
    const exits = Math.max(0, Math.round(entries * 0.9));
    out.push({ camera_id: "cam-entrance", start: isoAt(t), entries, exits, peak_occupancy: Math.min(9, Math.round(entries / 2)) });
    out.push({ camera_id: "cam-dining", start: isoAt(t), entries: 0, exits: 0, peak_occupancy: Math.round(entries * 2.2) });
    out.push({ camera_id: "cam-counter", start: isoAt(t), entries: 0, exits: 0, peak_occupancy: Math.min(8, Math.round(entries / 3) + 1) });
  }
  return out;
}

function addAudit(actor, action, subject, payload = {}, msAgo = 0) {
  db.audit.push({ seq: db.audit.length + 1, at: iso(msAgo), actor, action, subject, payload });
}

// As implemented by core: disabled cameras count as NOT_CONNECTED; an engine
// error forces every connected camera to at least AI_UNAVAILABLE.
function effectiveState(c) {
  if (!c.enabled) return "NOT_CONNECTED";
  if (db.services.engine !== "ok" && STATE_RANK[c.state] < STATE_RANK.AI_UNAVAILABLE) return "AI_UNAVAILABLE";
  return c.state;
}

function roomState(roomId) {
  const cs = db.cameras.filter((c) => c.room_id === roomId);
  if (cs.length === 0) return "NOT_CONNECTED";
  return cs.map(effectiveState).reduce((w, st) => (STATE_RANK[st] > STATE_RANK[w] ? st : w), "FULLY_OPERATIONAL");
}

function overview() {
  const rooms = db.rooms.map((r) => ({
    id: r.id, name: r.name, state: roomState(r.id),
    cameras: db.cameras.filter((c) => c.room_id === r.id).map((c) => ({ id: c.id, name: c.name, state: effectiveState(c), since: c.state_since, priority: c.priority })),
  }));
  const state = rooms.reduce((w, r) => (STATE_RANK[r.state] > STATE_RANK[w] ? r.state : w), "FULLY_OPERATIONAL");
  const now = Date.now();
  return {
    facility: db.facility,
    business: { open: db.businessOverride ?? isOpen(now), timezone: TZ, today: SITE.business_hours.weekly[DAY_KEYS[local(now).wd]] ?? [] },
    state, rooms,
    open_alerts: db.incidents.filter((i) => i.status === "ALERTED" && i.lifecycle !== "resolved").length,
    alerts_health: db.alerts_health, services: db.services, generated_at: iso(),
  };
}

function visibleIncidents(user, includeShadow) {
  const canShadow = PERMS[user.role].includes("view_shadow");
  return db.incidents.filter((i) => i.status !== "SHADOW" || (canShadow && includeShadow));
}

const summary = (i) => {
  const rest = { ...i };
  delete rest.actions;
  delete rest.clips;
  return rest;
};

// ---------------------------------------------------------------- SSE
function broadcast(type, data, { shadow = false } = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.stalled) continue;
    if (shadow && !PERMS[c.user.role].includes("view_shadow")) continue;
    c.res.write(msg);
  }
}
setInterval(() => {
  for (const c of sseClients) {
    // Pings do not extend the session; the stream ends once the session has idled out.
    const s = sessions.get(c.tok);
    if (!s || Date.now() - s.lastSeen > IDLE_MS) {
      sessions.delete(c.tok);
      c.res.end();
      sseClients.delete(c);
      continue;
    }
    if (!c.stalled) c.res.write(": ping\n\n");
  }
}, PING_MS).unref();

// ---------------------------------------------------------------- http helpers
function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(payload);
}
const err = (res, status, msg, headers) => send(res, status, { error: msg }, headers);

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}
function currentUser(req) {
  const tok = parseCookies(req).zeoatap_session;
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  if (Date.now() - s.lastSeen > IDLE_MS) {
    sessions.delete(tok);
    return null;
  }
  s.lastSeen = Date.now();
  const u = db.users.find((x) => x.id === s.userId);
  return u && !u.disabled ? u : null;
}
function endSessionsOf(userId) {
  for (const [tok, s] of sessions) if (s.userId === userId) sessions.delete(tok);
  for (const c of sseClients) {
    if (c.user.id === userId) {
      c.res.end();
      sseClients.delete(c);
    }
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain", ".woff2": "font/woff2" };
function serveStatic(req, res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) return err(res, 404, "not found (no static build; run next build)");
  let p = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(STATIC_DIR, p);
  if (!file.startsWith(STATIC_DIR)) return err(res, 400, "bad path");
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(301, { Location: pathname + "/" });
      return res.end();
    }
    file = path.join(file, "index.html");
  }
  if (!fs.existsSync(file)) {
    file = path.join(STATIC_DIR, "404.html");
    if (!fs.existsSync(file)) return err(res, 404, "not found");
    res.writeHead(404, { "Content-Type": MIME[".html"] });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function serveClip(req, res) {
  if (!CLIP_OK) return err(res, 500, "mock clip fixture missing (ffmpeg not available)");
  const stat = fs.statSync(CLIP_FILE);
  const range = req.headers.range;
  const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(CLIP_FILE, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  fs.createReadStream(CLIP_FILE).pipe(res);
}

// ---------------------------------------------------------------- validation
function validateZones(zones) {
  if (!Array.isArray(zones)) return "zones must be an array";
  for (const z of zones) {
    if (!z || typeof z.id !== "string" || !z.id) return "each zone needs an id";
    if (!ZONE_KINDS.includes(z.kind)) return `zone ${z.id}: kind must be one of ${ZONE_KINDS.join(", ")}`;
    if (!Array.isArray(z.polygon)) return `zone ${z.id}: polygon must be an array`;
    if (z.kind === "count_line" ? z.polygon.length !== 2 : z.polygon.length < 3) return `zone ${z.id}: ${z.kind === "count_line" ? "a count_line needs exactly 2 points" : "polygon needs at least 3 points"}`;
    for (const p of z.polygon) if (typeof p?.X !== "number" || typeof p?.Y !== "number" || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1) return `zone ${z.id}: points must be {X,Y} in 0..1`;
  }
  return null;
}

/** Time range from ?from=&to= (RFC 3339), defaulting to the last 7 days; null if invalid or > maxDays. */
function parseRange(url, maxDays) {
  const now = Date.now();
  const to = url.searchParams.get("to") ? Date.parse(url.searchParams.get("to")) : now;
  const from = url.searchParams.get("from") ? Date.parse(url.searchParams.get("from")) : to - 7 * DAY;
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) return { error: "from must be before to (RFC 3339)" };
  if (maxDays && to - from > maxDays * DAY) return { error: `range is at most ${maxDays} days` };
  return { from, to };
}
const clampLimit = (v, dflt) => Math.max(1, Math.min(1000, Number(v ?? dflt) || dflt));

// ---------------------------------------------------------------- login throttling
function lockState(key, now) {
  let s = loginFails.get(key);
  if (!s) {
    s = { times: [], lockedUntil: 0, lockAudited: false };
    loginFails.set(key, s);
  }
  s.times = s.times.filter((t) => now - t < LOCK_WINDOW_MS);
  if (s.lockedUntil && s.lockedUntil <= now) {
    s.lockedUntil = 0;
    s.lockAudited = false;
  }
  return s;
}

// ---------------------------------------------------------------- router
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;
  const method = req.method ?? "GET";

  if (p.startsWith("/__mock/")) return mockControl(req, res, p);
  if (p === "/healthz") return send(res, 200, { ok: true });
  if (p === "/readyz") return db.services.engine === "ok" && db.services.database === "ok" ? send(res, 200, { ok: true }) : err(res, 503, "unhealthy");
  if (!p.startsWith("/api/")) return serveStatic(req, res, p);

  if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));

  let body = {};
  if (method === "POST") {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) return err(res, 415, "Content-Type must be application/json");
    const raw = await readBody(req);
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return err(res, 400, "invalid JSON");
    }
  }

  // --- unauthenticated
  if (p === "/api/v1/login" && method === "POST") {
    const now = Date.now();
    const name = String(body.username ?? "");
    const uKey = `u:${name}`;
    const ipKey = `ip:${req.socket.remoteAddress ?? "?"}`;
    const us = lockState(uKey, now);
    const is = lockState(ipKey, now);
    const lockedUntil = Math.max(us.lockedUntil, is.lockedUntil);
    if (lockedUntil > now) {
      // While locked, attempts are refused without being audited (the lock itself was audited once).
      return err(res, 429, "too many failed sign-in attempts; try again later", { "Retry-After": String(Math.ceil((lockedUntil - now) / 1000)) });
    }
    const u = db.users.find((x) => x.username === name);
    if (!u || u.disabled || body.password !== PASSWORD) {
      us.times.push(now);
      is.times.push(now);
      addAudit(name || "?", "login_failed", name || "?");
      for (const [s, limit, subject] of [[us, USER_FAIL_LIMIT, name], [is, IP_FAIL_LIMIT, ipKey]]) {
        if (s.times.length >= limit && !s.lockedUntil) {
          s.lockedUntil = now + LOCK_WINDOW_MS;
          if (!s.lockAudited) {
            s.lockAudited = true;
            addAudit("system", "login_locked", subject, { until: isoAt(s.lockedUntil) });
          }
        }
      }
      return err(res, 401, "Incorrect username or password");
    }
    us.times = [];
    const tok = crypto.randomBytes(24).toString("hex");
    sessions.set(tok, { userId: u.id, lastSeen: now });
    addAudit(u.username, "login", u.username);
    return send(res, 200, { user: u, permissions: PERMS[u.role] }, { "Set-Cookie": `zeoatap_session=${tok}; HttpOnly; SameSite=Strict; Path=/` });
  }
  if (p === "/api/v1/logout" && method === "POST") {
    const tok = parseCookies(req).zeoatap_session;
    if (tok) sessions.delete(tok);
    res.writeHead(204, { "Set-Cookie": "zeoatap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    return res.end();
  }

  const clipMedia = /^\/api\/v1\/clips\/([^/]+)\/media$/.exec(p);
  if (clipMedia && method === "GET") {
    const t = tokens.get(url.searchParams.get("token") ?? "");
    if (!t || t.clipId !== clipMedia[1] || t.expires < Date.now()) return err(res, 403, "clip token invalid or expired");
    const owner = db.users.find((u) => u.username === t.actor);
    if (!owner || owner.disabled || !PERMS[owner.role].includes("view_clips")) return err(res, 403, "clip token no longer valid");
    const clip = db.incidents.flatMap((x) => x.clips).find((c) => c.id === t.clipId);
    if (!clip || clip.deleted_at) return err(res, 410, "clip deleted under retention policy");
    // The first request for each token is audit-logged; if that write fails, nothing is served.
    if (!t.used) {
      if (db.auditFail) return err(res, 503, "clip access could not be audit-logged");
      addAudit(t.actor, "clip_viewed", t.clipId);
      t.used = true;
    }
    return serveClip(req, res);
  }

  // --- authenticated
  const user = currentUser(req);
  if (!user) return err(res, 401, "not signed in");
  const perms = PERMS[user.role];
  const need = (perm) => {
    if (!perms.includes(perm)) {
      err(res, 403, `your role (${user.role}) does not have the ${perm} permission`);
      return false;
    }
    return true;
  };

  if (p === "/api/v1/me" && method === "GET") return send(res, 200, { user, permissions: perms });

  if (p === "/api/v1/overview" && method === "GET") return need("view_status") && send(res, 200, overview());

  if (p === "/api/v1/events" && method === "GET") {
    if (!need("view_status")) return;
    if (Date.now() < refuseSseUntil) return err(res, 503, "event stream temporarily unavailable");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("retry: 3000\n: connected\n\n");
    sseConnects++;
    const tok = parseCookies(req).zeoatap_session;
    const client = { res, user, tok, stalled: false };
    sseClients.add(client);
    req.on("close", () => sseClients.delete(client));
    return;
  }

  if (p === "/api/v1/cameras") {
    if (method === "GET") return need("view_status") && send(res, 200, db.cameras);
    if (method === "POST") {
      if (!need("admin")) return;
      for (const f of ["id", "room_id", "name", "authorized_by", "authorized_at", "authorization_scope"]) {
        if (typeof body[f] !== "string" || !body[f].trim()) return err(res, 400, `${f} is required`);
      }
      if (db.cameras.some((c) => c.id === body.id)) return err(res, 409, `camera ${body.id} already exists`);
      const zerr = validateZones(body.zones ?? []);
      if (zerr) return err(res, 400, zerr);
      if (!db.rooms.some((r) => r.id === body.room_id)) db.rooms.push({ id: body.room_id, name: body.room_id });
      const c = {
        id: body.id, room_id: body.room_id, name: body.name, priority: !!body.priority, staff_only: !!body.staff_only, zones: body.zones ?? [],
        authorized_by: body.authorized_by, authorized_at: body.authorized_at, authorization_scope: body.authorization_scope,
        enabled: body.enabled !== false, state: "NOT_CONNECTED", state_since: iso(),
      };
      db.cameras.push(c);
      addAudit(user.username, "camera_registered", c.id, { authorized_by: c.authorized_by });
      broadcast("camera_state", { camera_id: c.id, state: c.state, since: c.state_since });
      return send(res, 201, c);
    }
  }

  if (p === "/api/v1/incidents" && method === "GET") {
    if (!need("view_status")) return;
    const wantShadow = url.searchParams.get("shadow") === "1";
    let list = visibleIncidents(user, wantShadow);
    if (url.searchParams.get("open") === "1") list = list.filter((i) => i.lifecycle !== "resolved");
    const posRef = (url.searchParams.get("pos_ref") ?? "").trim().toLowerCase();
    if (posRef) list = list.filter((i) => (i.pos_ref ?? "").toLowerCase() === posRef);
    list = [...list].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    const snapshot = list.slice(0, clampLimit(url.searchParams.get("limit"), 100)).map(summary);
    if (incidentsDelayMs) await new Promise((r) => setTimeout(r, incidentsDelayMs));
    return send(res, 200, snapshot);
  }

  const inc = /^\/api\/v1\/incidents\/([^/]+)(?:\/(ack|disposition|hold))?$/.exec(p);
  if (inc) {
    if (!need("view_status")) return;
    const i = db.incidents.find((x) => x.id === inc[1]);
    if (!i || (i.status === "SHADOW" && !perms.includes("view_shadow"))) return err(res, 404, "incident not found");
    const op = inc[2];
    if (!op && method === "GET") return send(res, 200, i);
    if (op === "ack" && method === "POST") {
      if (!need("acknowledge")) return;
      if (i.lifecycle === "new") {
        i.lifecycle = "acknowledged";
        i.acknowledged_by = user.username;
        i.acknowledged_at = iso();
        i.actions.push({ actor: user.username, action: "acknowledged", disposition: null, note: null, at: iso() });
        addAudit(user.username, "incident_acknowledged", i.id);
        broadcast("incident_updated", i, { shadow: i.status === "SHADOW" });
      }
      return send(res, 200, i);
    }
    if (op === "disposition" && method === "POST") {
      if (!need("disposition")) return;
      if (i.lifecycle === "resolved") return err(res, 409, "incident already resolved");
      if (!DISPOSITIONS.includes(body.disposition)) return err(res, 400, "invalid disposition");
      i.lifecycle = "resolved";
      i.disposition = body.disposition;
      i.resolved_by = user.username;
      i.resolved_at = iso();
      if (!i.acknowledged_at) {
        i.acknowledged_by = user.username;
        i.acknowledged_at = iso();
      }
      i.actions.push({ actor: user.username, action: "disposition", disposition: body.disposition, note: body.note || null, at: iso() });
      addAudit(user.username, "incident_disposition", i.id, { disposition: body.disposition });
      broadcast("incident_updated", i, { shadow: i.status === "SHADOW" });
      return send(res, 200, i);
    }
    if (op === "hold" && method === "POST") {
      if (!need("legal_hold")) return;
      i.legal_hold = !!body.hold;
      i.actions.push({ actor: user.username, action: i.legal_hold ? "legal_hold_set" : "legal_hold_released", disposition: null, note: null, at: iso() });
      addAudit(user.username, i.legal_hold ? "legal_hold_set" : "legal_hold_released", i.id);
      broadcast("incident_updated", i, { shadow: i.status === "SHADOW" });
      return send(res, 200, i);
    }
  }

  const clipTok = /^\/api\/v1\/clips\/([^/]+)\/token$/.exec(p);
  if (clipTok && method === "POST") {
    if (!need("view_clips")) return;
    const owner = db.incidents.find((x) => x.clips.some((c) => c.id === clipTok[1]));
    const clip = owner?.clips.find((c) => c.id === clipTok[1]);
    if (!clip || (owner.status === "SHADOW" && !perms.includes("view_shadow"))) return err(res, 404, "clip not found");
    const t = crypto.randomBytes(16).toString("hex");
    const expires = Date.now() + 5 * MIN;
    tokens.set(t, { clipId: clip.id, expires, actor: user.username, used: false });
    addAudit(user.username, "clip_token_issued", clip.id);
    return send(res, 200, { url: `/api/v1/clips/${clip.id}/media?token=${t}`, expires_at: new Date(expires).toISOString() });
  }

  if (p === "/api/v1/analytics/traffic" && method === "GET") {
    if (!need("view_analytics")) return;
    const r = parseRange(url, 92);
    if (r.error) return err(res, 400, r.error);
    return send(res, 200, { timezone: TZ, bucket_minutes: 15, from: isoAt(r.from), to: isoAt(r.to), buckets: trafficBuckets(r.from, r.to) });
  }

  if (p === "/api/v1/access-log" && method === "GET") {
    if (!need("view_access_log")) return;
    const r = parseRange(url, 0);
    if (r.error) return err(res, 400, r.error);
    const list = db.accessLog.filter((v) => {
      const t = Date.parse(v.start);
      return t >= r.from && t < r.to;
    });
    return send(res, 200, list.slice(0, clampLimit(url.searchParams.get("limit"), 100)));
  }

  if (p === "/api/v1/users") {
    if (!need("admin")) return;
    if (method === "GET") return send(res, 200, db.users);
    if (method === "POST") {
      const { username, display_name, role, password } = body;
      if (!username || !/^[a-z0-9._-]{2,32}$/.test(username)) return err(res, 400, "username must be 2–32 characters: a–z, 0–9, . _ -");
      if (!PERMS[role]) return err(res, 400, "invalid role");
      if (typeof password !== "string" || password.length < 12) return err(res, 400, "password must be at least 12 characters");
      if (db.users.some((u) => u.username === username)) return err(res, 409, "username already exists");
      const u = { id: db.nextUserId++, username, display_name: display_name || username, role, disabled: false };
      db.users.push(u);
      addAudit(user.username, "user_created", username, { role });
      return send(res, 201, u);
    }
  }

  const userEdit = /^\/api\/v1\/users\/(\d+)$/.exec(p);
  if (userEdit && method === "POST") {
    if (!need("admin")) return;
    const u = db.users.find((x) => x.id === Number(userEdit[1]));
    if (!u) return err(res, 404, "user not found");
    const self = u.id === user.id;
    if (body.role !== undefined && !PERMS[body.role]) return err(res, 400, "invalid role");
    if (body.password !== undefined && (typeof body.password !== "string" || body.password.length < 12)) return err(res, 400, "password must be at least 12 characters");
    if (body.display_name !== undefined && (typeof body.display_name !== "string" || !body.display_name.trim())) return err(res, 400, "display_name must not be empty");
    if (self && body.disabled === true) return err(res, 400, "you cannot disable your own account");
    if (self && body.role !== undefined && body.role !== u.role) return err(res, 400, "you cannot change your own role");
    let endSessions = false;
    const changed = {};
    if (body.display_name !== undefined) u.display_name = changed.display_name = body.display_name.trim();
    if (body.role !== undefined && body.role !== u.role) {
      u.role = changed.role = body.role;
      endSessions = true;
    }
    if (body.disabled !== undefined && !!body.disabled !== u.disabled) {
      u.disabled = changed.disabled = !!body.disabled;
      if (u.disabled) endSessions = true;
    }
    if (body.password !== undefined) {
      changed.password = "reset";
      endSessions = true;
    }
    if (endSessions) endSessionsOf(u.id);
    addAudit(user.username, "user_updated", u.username, changed);
    return send(res, 200, u);
  }

  if (p === "/api/v1/audit" && method === "GET") {
    if (!need("admin")) return;
    const entries = [...db.audit].reverse().slice(0, clampLimit(url.searchParams.get("limit"), 100));
    return send(res, 200, { entries, chain_ok: !db.auditBroken, broken_at: db.auditBroken ? 7 : 0 });
  }

  return err(res, 404, "not found");
}

async function mockControl(req, res, p) {
  const raw = req.method === "POST" ? await readBody(req) : "";
  const body = raw ? JSON.parse(raw) : {};
  switch (p) {
    case "/__mock/reset":
      seed(body.scenario ?? "default");
      sessions = new Map();
      tokens = new Map();
      loginFails = new Map();
      refuseSseUntil = 0;
      latencyMs = 0;
      incidentsDelayMs = 0;
      for (const c of sseClients) c.res.end();
      sseClients = new Set();
      return send(res, 200, { ok: true });
    case "/__mock/scenario":
      seed(body.name ?? "default");
      return send(res, 200, { ok: true });
    case "/__mock/camera_state": {
      const c = db.cameras.find((x) => x.id === body.camera_id);
      if (!c) return err(res, 404, "no such camera");
      c.state = body.state;
      c.state_since = iso();
      broadcast("camera_state", { camera_id: c.id, state: c.state, since: c.state_since });
      return send(res, 200, c);
    }
    case "/__mock/incident": {
      const n = crypto.randomBytes(6).toString("hex");
      const type = body.event_type ?? "long_queue";
      const i = incident({
        id: `INC-${n}`, room_id: body.room_id ?? "counter", room_zone: body.room_zone ?? "counter-queue",
        event_type: type, agoStart: 2000, cameras: body.cameras ?? ["cam-counter"],
        status: body.status ?? "ALERTED", lifecycle: "new", pos_ref: body.pos_ref, source: body.pos_ref ? "POS" : "MOCK",
        detail: body.detail ?? "6 people in the counter queue for 60 s.",
        uncertainty: "low", visibility: "good",
      });
      db.incidents.unshift(i);
      if (body.silent) return send(res, 200, i);
      const shadow = i.status === "SHADOW";
      broadcast("incident_created", i, { shadow });
      if (i.status === "ALERTED") broadcast("alert", { incident_id: i.id, room_id: i.room_id, event_type: i.event_type, level: 0 });
      return send(res, 200, i);
    }
    case "/__mock/resolve": {
      // Resolves an incident WITHOUT broadcasting, to simulate a concurrent manager (409 path).
      const i = db.incidents.find((x) => x.id === body.id);
      if (!i) return err(res, 404, "no such incident");
      i.lifecycle = "resolved";
      i.disposition = body.disposition ?? "ok";
      i.resolved_by = body.actor ?? "other-manager";
      i.resolved_at = iso();
      i.actions.push({ actor: i.resolved_by, action: "disposition", disposition: i.disposition, note: null, at: iso() });
      return send(res, 200, i);
    }
    case "/__mock/clip_delete": {
      const clip = db.incidents.flatMap((x) => x.clips).find((c) => c.id === body.id);
      if (!clip) return err(res, 404, "no such clip");
      clip.deleted_at = iso();
      return send(res, 200, clip);
    }
    case "/__mock/audit_fail":
      db.auditFail = !!body.on;
      return send(res, 200, { ok: true });
    case "/__mock/services":
      Object.assign(db.services, body);
      return send(res, 200, db.services);
    case "/__mock/business":
      db.businessOverride = typeof body.open === "boolean" ? body.open : null;
      return send(res, 200, overview().business);
    case "/__mock/emit":
      broadcast(body.type, body.data);
      return send(res, 200, { ok: true });
    case "/__mock/sse/drop":
      refuseSseUntil = Date.now() + Number(body.refuse_ms ?? 0);
      for (const c of sseClients) c.res.destroy();
      sseClients = new Set();
      return send(res, 200, { ok: true });
    case "/__mock/sse/stall":
      for (const c of sseClients) c.stalled = true;
      return send(res, 200, { ok: true, stalled: sseClients.size });
    case "/__mock/sessions/expire":
      sessions = new Map();
      for (const c of sseClients) c.res.destroy();
      sseClients = new Set();
      return send(res, 200, { ok: true });
    case "/__mock/latency":
      latencyMs = Number(body.ms ?? 0);
      return send(res, 200, { ok: true });
    case "/__mock/incidents_delay":
      incidentsDelayMs = Number(body.ms ?? 0);
      return send(res, 200, { ok: true });
    case "/__mock/state":
      return send(res, 200, { ...db, sessions: sessions.size, sse_clients: sseClients.size, sse_connects: sseConnects });
    default:
      return err(res, 404, "unknown mock control");
  }
}

seed(process.env.SCENARIO ?? "default");
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) err(res, 500, "mock server error");
  });
});
server.listen(PORT, HOST, () => {
  console.log(`zeoatap mock core listening on http://${HOST}:${PORT} (static: ${fs.existsSync(STATIC_DIR) ? STATIC_DIR : "none"}; site: ${SITE.facility.name})`);
});
