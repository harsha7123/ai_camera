// Shapes from packages/contracts/API.md (v2, restaurant). Keep in sync with that file.

export type Role = "staff" | "manager" | "owner" | "admin";
export type Permission =
  | "view_status"
  | "acknowledge"
  | "view_clips"
  | "disposition"
  | "view_analytics"
  | "view_access_log"
  | "view_shadow"
  | "legal_hold"
  | "admin";

export type MonitoringState =
  | "CAMERA_UNAVAILABLE"
  | "NOT_CONNECTED"
  | "AI_UNAVAILABLE"
  | "VIDEO_DEGRADED"
  | "FULLY_OPERATIONAL";

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  disabled: boolean;
}

export interface Me {
  user: User;
  permissions: Permission[];
}

export interface Point {
  X: number;
  Y: number;
}
export type ZoneKind = "restricted" | "secure" | "staff_area" | "queue" | "post" | "customer_side" | "floor" | "count_line";
export interface Zone {
  id: string;
  room_zone: string;
  kind: ZoneKind;
  polygon: Point[];
}

export interface Camera {
  id: string;
  room_id: string;
  name: string;
  /** Register/POS camera: analysed at 15 fps instead of 5. */
  priority: boolean;
  /** Kitchen / back of house: anyone seen here is treated as staff. */
  staff_only: boolean;
  zones: Zone[];
  authorized_by: string;
  authorized_at: string;
  authorization_scope: string;
  enabled: boolean;
  state: MonitoringState;
  state_since: string;
}

export type IncidentStatus = "ALERTED" | "REVIEW_QUEUED" | "SHADOW" | "INCONCLUSIVE";
export type Lifecycle = "new" | "acknowledged" | "resolved";
export type Disposition = "ok" | "coach" | "investigate" | "false_detection" | "escalated_external" | "inconclusive";

export interface IncidentAction {
  actor: string;
  action: string;
  disposition: Disposition | null;
  note: string | null;
  at: string;
}

export interface Clip {
  id: string;
  camera_id: string;
  sha256: string;
  size_bytes: number;
  partial: boolean;
  start: string;
  end: string;
  created_at: string;
  deleted_at: string | null;
}

export interface Incident {
  id: string;
  room_id: string;
  room_zone: string;
  event_type: string;
  family: string;
  start: string;
  end: string;
  cameras: string[];
  status: IncidentStatus;
  lifecycle: Lifecycle;
  escalation_level: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  disposition: Disposition | null;
  resolved_by: string | null;
  resolved_at: string | null;
  rule_version: string;
  model_versions: Record<string, string>;
  source: string;
  detail: string;
  /** POS ticket reference for POS-linked incidents (searchable with ?pos_ref=). */
  pos_ref?: string | null;
  created_at: string;
  retention_deadline: string;
  legal_hold: boolean;
  // Not in API.md; shown only when the core provides them.
  uncertainty?: string;
  visibility?: string;
  // Present on GET /incidents/{id} (and possibly on SSE incident payloads).
  actions?: IncidentAction[];
  clips?: Clip[];
}

export interface OverviewCamera {
  id: string;
  name: string;
  state: MonitoringState;
  since: string;
  priority: boolean;
}
export interface OverviewRoom {
  id: string;
  name: string;
  state: MonitoringState;
  cameras: OverviewCamera[];
}
export interface Overview {
  facility: { id: string; name: string };
  /** Business hours evaluated by the core in the site's IANA timezone. `today` holds [open, close] pairs (HH:MM, site time). */
  business?: { open: boolean; timezone: string; today: [string, string][] };
  state: MonitoringState;
  rooms: OverviewRoom[];
  open_alerts: number;
  alerts_health: { failed: number; delayed: number };
  services: {
    engine: "ok" | "error";
    engine_error: string;
    database: "ok" | "error";
    evidence: "ok" | "error";
  };
  generated_at: string;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  subject: string;
  payload: unknown;
}
export interface AuditResponse {
  entries: AuditEntry[];
  chain_ok: boolean;
  broken_at: number;
}

export interface TrafficBucket {
  camera_id: string;
  start: string;
  entries: number;
  exits: number;
  peak_occupancy: number;
}
export interface Traffic {
  timezone: string;
  bucket_minutes: number;
  from: string;
  to: string;
  buckets: TrafficBucket[];
}

export interface ZoneAccess {
  id: number;
  camera_id: string;
  room_id: string;
  room_zone: string;
  zone_id: string;
  role: "staff" | "person";
  start: string;
  end: string;
  after_hours: boolean;
}

export interface UserUpdate {
  display_name?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
}

export interface ClipToken {
  url: string;
  expires_at: string;
}

// SSE payloads
export interface CameraStateEvent {
  camera_id: string;
  state: MonitoringState;
  since: string;
}
export interface AlertEvent {
  incident_id: string;
  room_id: string;
  event_type: string;
  level: number;
}
export interface EscalatedEvent {
  incident_id: string;
  level: number;
}
export interface DeliveryFailedEvent {
  incident_id: string;
  channel: string;
  error: string;
}
export interface ClipReadyEvent {
  incident_id: string;
  clip_id: string;
  partial: boolean;
}
export interface ClipFailedEvent {
  incident_id: string;
  camera_id: string;
  error: string;
}
