// Presentation rules: wording, tones and icons for states and incidents.
// Wording is neutral and non-accusatory: these are automated observations
// that need human review, never findings.

import type { Disposition, Incident, IncidentStatus, Lifecycle, MonitoringState, Permission, Role } from "./types";

/** "unknown" is a client-side state: data is stale or the live stream is down. */
export type DisplayState = MonitoringState | "UNKNOWN";
export type Tone = "ok" | "degraded" | "unavailable" | "unknown" | "review" | "urgent" | "neutral";
export type IconName = "check" | "half" | "cross" | "question" | "bang" | "triangle" | "dot" | "pause";

export const STATE_RANK: Record<MonitoringState, number> = {
  CAMERA_UNAVAILABLE: 4,
  NOT_CONNECTED: 3,
  AI_UNAVAILABLE: 2,
  VIDEO_DEGRADED: 1,
  FULLY_OPERATIONAL: 0,
};

export function worstState(states: MonitoringState[], empty: MonitoringState = "NOT_CONNECTED"): MonitoringState {
  if (states.length === 0) return empty;
  return states.reduce((w, s) => (STATE_RANK[s] > STATE_RANK[w] ? s : w), "FULLY_OPERATIONAL" as MonitoringState);
}

interface StatePresentation {
  tone: Tone;
  icon: IconName;
  label: string; // short word(s) on the badge
  detail: string; // sentence for banners / tiles
}

export const STATE_PRESENTATION: Record<DisplayState, StatePresentation> = {
  FULLY_OPERATIONAL: { tone: "ok", icon: "check", label: "Fully monitored", detail: "All cameras and AI analysis are working." },
  VIDEO_DEGRADED: { tone: "degraded", icon: "half", label: "Degraded", detail: "Video quality is reduced. Detection may be less reliable." },
  AI_UNAVAILABLE: { tone: "unavailable", icon: "cross", label: "Not monitored", detail: "AI analysis is unavailable. No automated prompts will be raised." },
  NOT_CONNECTED: { tone: "unavailable", icon: "cross", label: "Not monitored", detail: "No camera is connected." },
  CAMERA_UNAVAILABLE: { tone: "unavailable", icon: "cross", label: "Not monitored", detail: "Camera offline." },
  UNKNOWN: { tone: "unknown", icon: "question", label: "Status unknown", detail: "Status cannot be confirmed: updates from the system have stopped." },
};

export const STATE_SHORT: Record<MonitoringState, string> = {
  FULLY_OPERATIONAL: "Fully operational",
  VIDEO_DEGRADED: "Video degraded",
  AI_UNAVAILABLE: "AI analysis unavailable",
  NOT_CONNECTED: "Not connected",
  CAMERA_UNAVAILABLE: "Camera offline",
};

// ------------------------------------------------------------------ incidents

/**
 * How pressing an event type is when it is alerted:
 * - urgent: safety or security, someone should look now;
 * - attention: operations or loss prevention, look soon;
 * - review: goes to the shift exception queue.
 */
export type EventTier = "urgent" | "attention" | "review";

interface EventInfo {
  label: string;
  tier: EventTier;
}

// Wording is "possible ..." throughout: these are prompts for a manager to
// review, never findings about a person.
const EVENTS: Record<string, EventInfo> = {
  after_hours_intrusion: { label: "Possible after-hours intrusion", tier: "urgent" },
  camera_tamper: { label: "Possible camera tampering or blocked view", tier: "urgent" },
  person_down: { label: "Possible person down (slip or fall)", tier: "urgent" },
  pos_refund_no_customer: { label: "Refund/void with no customer seen", tier: "attention" },
  unattended_post: { label: "Post unattended", tier: "attention" },
  long_queue: { label: "Long queue", tier: "attention" },
  restricted_zone_entry: { label: "Possible non-staff entry to a restricted area", tier: "review" },
  long_wait: { label: "Long wait in queue", tier: "review" },
  pos_no_sale: { label: "No-sale drawer open", tier: "review" },
};

export function eventLabel(type: string): string {
  return EVENTS[type]?.label ?? `Possible event: ${humanize(type)}`;
}

export function eventTier(type: string | undefined): EventTier {
  return (type && EVENTS[type]?.tier) || "review";
}

/** Playbook families (API.md event table). */
export const FAMILY_LABEL: Record<string, string> = {
  A: "Traffic and demand",
  B: "Workforce",
  C: "Cash and POS",
  D: "Back-of-house shrink",
  E: "Customer-side theft",
  F: "Safety and conduct",
  G: "After-hours and system integrity",
  H: "Customer experience",
};

export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface SeverityPresentation {
  tone: Tone;
  icon: IconName;
  label: string;
  rank: number; // higher = more severe, used for sorting
}

/**
 * Severity derives from status + lifecycle, refined by the event type's tier
 * (the API has no separate severity field).
 */
export function severity(i: Pick<Incident, "status" | "lifecycle" | "escalation_level"> & { event_type?: string }): SeverityPresentation {
  const tier = eventTier(i.event_type);
  if (i.status === "ALERTED") {
    if (i.lifecycle === "new") {
      return tier === "urgent"
        ? { tone: "urgent", icon: "triangle", label: "Urgent alert", rank: 6 }
        : { tone: "urgent", icon: "triangle", label: "Alert", rank: 5 };
    }
    if (i.lifecycle === "acknowledged") return { tone: "review", icon: "bang", label: "Alert · review required", rank: 4 };
    return { tone: "neutral", icon: "check", label: "Alert · resolved", rank: 1 };
  }
  if (i.status === "REVIEW_QUEUED") {
    return i.lifecycle === "resolved"
      ? { tone: "neutral", icon: "check", label: "Reviewed", rank: 1 }
      : { tone: "review", icon: "bang", label: "Review required", rank: 3 };
  }
  if (i.status === "INCONCLUSIVE") return { tone: "neutral", icon: "half", label: "Inconclusive", rank: i.lifecycle === "resolved" ? 1 : 2 };
  return { tone: "neutral", icon: "pause", label: "Shadow mode", rank: 0 };
}

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  ALERTED: "Alerted",
  REVIEW_QUEUED: "Review queued",
  SHADOW: "Shadow (tuning; nobody alerted)",
  INCONCLUSIVE: "Inconclusive",
};

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  new: "New — not yet acknowledged",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};
export const LIFECYCLE_SHORT: Record<Lifecycle, string> = { new: "New", acknowledged: "Acknowledged", resolved: "Resolved" };
export const LIFECYCLE_RANK: Record<Lifecycle, number> = { new: 0, acknowledged: 1, resolved: 2 };

// The playbook's shift exception queue: "manager marks OK / coach / investigate".
export const DISPOSITIONS: { value: Disposition; label: string; hint: string }[] = [
  { value: "ok", label: "OK", hint: "Reviewed; normal activity, nothing to follow up." },
  { value: "coach", label: "Coach", hint: "A coaching conversation per your policy. Never discipline on an alert alone." },
  { value: "investigate", label: "Investigate", hint: "Needs a closer look (POS records, other footage) before any conclusion." },
  { value: "false_detection", label: "False detection", hint: "The system misread the scene." },
  { value: "escalated_external", label: "Escalated externally", hint: "Referred outside the restaurant (insurer, police) per policy, after human review." },
  { value: "inconclusive", label: "Inconclusive", hint: "The evidence is not enough to decide." },
];
export const DISPOSITION_LABEL = Object.fromEntries(DISPOSITIONS.map((d) => [d.value, d.label])) as Record<Disposition, string>;

/** Waiting for someone to acknowledge. SHADOW incidents never page anyone, so they never need it. */
export function needsAck(i: Pick<Incident, "lifecycle" | "status">): boolean {
  return i.lifecycle === "new" && i.status !== "SHADOW";
}

/** Milliseconds since the epoch, or 0 for a missing/invalid timestamp (sorts oldest). */
export function timeOf(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function sortIncidents(list: Incident[]): Incident[] {
  return [...list].sort((a, b) => {
    const pa = needsAck(a) ? 1 : 0;
    const pb = needsAck(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const sa = severity(a).rank;
    const sb = severity(b).rank;
    if (sa !== sb) return sb - sa;
    return timeOf(b.start) - timeOf(a.start);
  });
}

// ------------------------------------------------------------------ time

export function ageSeconds(isoOrMs: string | number, now: number): number {
  const t = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((now - t) / 1000));
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

const timeFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
const dateTimeFmt =
  typeof Intl !== "undefined"
    ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = new Date().toDateString() === d.toDateString();
  return (sameDay ? timeFmt : dateTimeFmt)?.format(d) ?? iso;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dateTimeFmt?.format(d) ?? iso;
}

export function durationSeconds(start: string, end: string): number | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round(Math.abs(b - a) / 100) / 10);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ roles

export const ROLE_LABEL: Record<Role, string> = { staff: "Staff", manager: "Manager", owner: "Owner", admin: "Administrator" };

export const PERMISSION_LABEL: Record<Permission, string> = {
  view_status: "View status",
  acknowledge: "Acknowledge alerts",
  view_clips: "View clips",
  disposition: "Record dispositions",
  view_analytics: "View traffic analytics",
  view_access_log: "View the access log",
  view_shadow: "View shadow-mode incidents",
  legal_hold: "Legal hold",
  admin: "Administration",
};
