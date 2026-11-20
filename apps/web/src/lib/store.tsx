"use client";

// Signed-in application state: who am I, restaurant overview, incident list,
// the live event stream (with reconnect, liveness check and full re-fetch),
// toasts and sound.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, notifyUnauthorized, setUnauthorizedHandler } from "./api";
import { LIFECYCLE_RANK, eventLabel, eventTier, worstState } from "./present";
import { enableSound, disableSound, playChime, soundSupported } from "./sound";
import type {
  AlertEvent,
  CameraStateEvent,
  DeliveryFailedEvent,
  EscalatedEvent,
  Incident,
  Me,
  Overview,
  Permission,
} from "./types";

const noopSubscribe = () => () => {};

/** Overview is polled this often, in addition to live events. */
export const OVERVIEW_POLL_MS = 5_000;
/** Older than this (or live stream down) → status shown as unknown, never green. */
export const STALE_MS = 15_000;
const INCIDENT_POLL_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;
/** The core sends a `: ping` comment every 15 s. Silence for ~2 intervals means the stream is dead. */
export const SSE_PING_MS = 15_000;
export const SSE_LIVENESS_MS = 2 * SSE_PING_MS + 5_000;
const LIVENESS_CHECK_MS = 5_000;
/** Non-sticky toasts kept on screen at once. Sticky (urgent, unacknowledged) toasts are never evicted. */
export const MAX_TRANSIENT_TOASTS = 4;

export type LiveStatus = "connecting" | "open" | "down";

export const SSE_TYPES = [
  "camera_state",
  "incident_created",
  "incident_merged",
  "incident_updated",
  "alert",
  "incident_escalated",
  "alert_delivery_failed",
  "clip_ready",
  "clip_failed",
] as const;
export type SseType = (typeof SSE_TYPES)[number];
export type SseHandler = (type: SseType, data: unknown) => void;

export interface Toast {
  id: number;
  tone: "urgent" | "review" | "degraded" | "neutral";
  title: string;
  body?: string;
  href?: string;
  sticky?: boolean;
  /** Sticky alert toasts are cleared once their incident is acknowledged. */
  incidentId?: string;
}

interface AppState {
  me: Me;
  can: (p: Permission) => boolean;
  overview: Overview | null;
  overviewAt: number | null;
  overviewError: string | null;
  incidents: Incident[] | null;
  incidentsError: string | null;
  refreshOverview: () => Promise<void>;
  refreshIncidents: () => Promise<void>;
  refreshAll: () => Promise<void>;
  upsertIncident: (i: Incident) => void;
  /** view_shadow roles only: include SHADOW incidents (core needs shadow=1). */
  showShadow: boolean;
  setShowShadow: (v: boolean) => void;
  live: { status: LiveStatus; downSince: number | null; reconnectAt: number | null };
  reconnectNow: () => void;
  subscribe: (h: SseHandler) => () => void;
  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  sound: { supported: boolean; enabled: boolean; toggle: () => Promise<void> };
  logout: () => Promise<void>;
  alertPulse: number; // increments on each alert, drives a visual pulse
}

const Ctx = createContext<AppState | null>(null);
const NowCtx = createContext<number>(0);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Current time, ticking once per second (for "Ns ago" displays). */
export function useNow(): number {
  return useContext(NowCtx);
}

export function isStale(overviewAt: number | null, live: LiveStatus, now: number): boolean {
  return overviewAt === null || now - overviewAt > STALE_MS || live !== "open";
}

function mergeIncident(list: Incident[], inc: Incident): Incident[] {
  const idx = list.findIndex((x) => x.id === inc.id);
  if (idx === -1) return [inc, ...list];
  const next = list.slice();
  next[idx] = { ...list[idx], ...inc };
  return next;
}

/** The newer of two copies of one incident. The lifecycle never moves backwards. */
function newer(local: Incident, fetched: Incident, localIsNewer: boolean): Incident {
  const lr = LIFECYCLE_RANK[local.lifecycle] ?? 0;
  const fr = LIFECYCLE_RANK[fetched.lifecycle] ?? 0;
  if (lr !== fr) return lr > fr ? { ...fetched, ...local } : { ...local, ...fetched };
  return localIsNewer ? { ...fetched, ...local } : { ...local, ...fetched };
}

/**
 * Merges a fetched incident list into the current one. Incidents missing from
 * the snapshot are dropped (they left the window), unless they changed locally
 * after the request started (e.g. created by a live event the snapshot missed).
 */
function mergeSnapshot(cur: Incident[], fetched: Map<string, Incident>, changedSince: (id: string) => boolean): Incident[] {
  const out: Incident[] = [];
  const seen = new Set<string>();
  for (const local of cur) {
    const f = fetched.get(local.id);
    if (f) {
      out.push(newer(local, f, changedSince(local.id)));
      seen.add(local.id);
    } else if (changedSince(local.id)) {
      out.push(local);
    }
  }
  for (const [id, f] of fetched) if (!seen.has(id)) out.push(f);
  return out;
}

/** Evicts the oldest non-sticky toasts beyond the cap. Sticky toasts stay until dismissed or acknowledged. */
export function capToasts(ts: Toast[]): Toast[] {
  const transient = ts.filter((t) => !t.sticky);
  const excess = transient.length - MAX_TRANSIENT_TOASTS;
  if (excess <= 0) return ts;
  const drop = new Set(transient.slice(0, excess).map((t) => t.id));
  return ts.filter((t) => !drop.has(t.id));
}

/**
 * Minimal text/event-stream reader. Calls `on(type, data)` for each event and
 * `on(null, "")` for each comment line (the core's `: ping`).
 */
async function readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, on: (type: string | null, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let type = "";
  let data: string[] = [];
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || signal.aborted) return;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\n|\r/)) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === "\r" && buf[nl + 1] === "\n" ? 2 : 1));
        if (line === "") {
          if (data.length) on(type || "message", data.join("\n"));
          type = "";
          data = [];
        } else if (line.startsWith(":")) {
          on(null, "");
        } else {
          const c = line.indexOf(":");
          const field = c === -1 ? line : line.slice(0, c);
          let val = c === -1 ? "" : line.slice(c + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") type = val;
          else if (field === "data") data.push(val);
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function AppProvider({ me, onSignedOut, children }: { me: Me; onSignedOut: (expired: boolean) => void; children: ReactNode }) {
  const perms = useMemo(() => new Set(me.permissions), [me.permissions]);
  const can = useCallback((p: Permission) => perms.has(p), [perms]);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewAt, setOverviewAt] = useState<number | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [incidentsError, setIncidentsError] = useState<string | null>(null);
  const [live, setLive] = useState<AppState["live"]>({ status: "connecting", downSince: null, reconnectAt: null });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const soundOk = useSyncExternalStore(noopSubscribe, soundSupported, () => false);
  const [alertPulse, setAlertPulse] = useState(0);

  const soundRef = useRef(false);
  const handlers = useRef(new Set<SseHandler>());
  const toastSeq = useRef(0);
  const signedOut = useRef(false);
  const reconnectRef = useRef<() => void>(() => {});

  // 401 anywhere → session over.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (signedOut.current) return;
      signedOut.current = true;
      onSignedOut(true);
    });
    return () => setUnauthorizedHandler(null);
  }, [onSignedOut]);

  const refreshOverview = useCallback(async () => {
    try {
      const o = await api.get<Overview>("/api/v1/overview");
      setOverview(o);
      setOverviewAt(Date.now());
      setOverviewError(null);
    } catch (e) {
      setOverviewError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const [showShadow, setShowShadowState] = useState(false);
  const showShadowRef = useRef(false);
  const setShowShadow = useCallback((v: boolean) => {
    showShadowRef.current = v;
    setShowShadowState(v);
  }, []);

  // Incident freshness. Every local change (SSE event, our own POST result)
  // bumps `clock` and stamps the incident. A list refresh remembers the clock
  // when it started; anything stamped later is newer than that snapshot and
  // wins. Responses are applied in request order: a slower, older refresh
  // never overwrites a newer one.
  const clock = useRef(0);
  const touched = useRef(new Map<string, number>());
  const refreshSeq = useRef(0);
  const appliedSeq = useRef(0);

  const shadowQ = perms.has("view_shadow") && showShadow ? "&shadow=1" : "";
  const refreshIncidents = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const startedAt = clock.current;
    try {
      const [open, recent] = await Promise.all([
        api.get<Incident[]>(`/api/v1/incidents?open=1&limit=500${shadowQ}`),
        api.get<Incident[]>(`/api/v1/incidents?limit=200${shadowQ}`),
      ]);
      if (seq < appliedSeq.current) return; // a newer refresh already landed
      appliedSeq.current = seq;
      const fetched = new Map<string, Incident>();
      for (const i of [...recent, ...open]) fetched.set(i.id, i);
      setIncidents((cur) => mergeSnapshot(cur ?? [], fetched, (id) => (touched.current.get(id) ?? 0) > startedAt));
      setIncidentsError(null);
    } catch (e) {
      if (seq < appliedSeq.current) return;
      setIncidentsError(e instanceof Error ? e.message : String(e));
    }
  }, [shadowQ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshOverview(), refreshIncidents()]);
  }, [refreshOverview, refreshIncidents]);

  const dropAlertToasts = useCallback((incidentId: string) => {
    setToasts((ts) => (ts.some((t) => t.incidentId === incidentId) ? ts.filter((t) => t.incidentId !== incidentId) : ts));
  }, []);

  const upsertIncident = useCallback(
    (inc: Incident) => {
      if (inc.status === "SHADOW" && !showShadowRef.current) return;
      touched.current.set(inc.id, ++clock.current);
      setIncidents((list) => mergeIncident(list ?? [], inc));
      if (inc.lifecycle !== "new") dropAlertToasts(inc.id);
    },
    [dropAlertToasts],
  );

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastSeq.current;
    setToasts((ts) => capToasts([...ts, { ...t, id }]));
    if (!t.sticky) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 8000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);

  // Polling: overview every 5 s (drives the staleness check), incidents every 30 s.
  useEffect(() => {
    // Fetch-on-mount: loads from the API (an external system); state is only set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll();
    const a = setInterval(() => void refreshOverview(), OVERVIEW_POLL_MS);
    const b = setInterval(() => void refreshIncidents(), INCIDENT_POLL_MS);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refreshAll, refreshOverview, refreshIncidents]);

  // Debounced overview refresh after events that change counts / states.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const softRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refreshOverview(), 400);
  }, [refreshOverview]);

  const roomName = useCallback(
    (id: string) => overview?.rooms.find((r) => r.id === id)?.name ?? id,
    [overview],
  );
  const roomNameRef = useRef(roomName);
  useEffect(() => {
    roomNameRef.current = roomName;
  }, [roomName]);

  const onEvent = useCallback(
    (type: SseType, data: unknown) => {
      switch (type) {
        case "camera_state": {
          const ev = data as CameraStateEvent;
          setOverview((o) => {
            if (!o) return o;
            const rooms = o.rooms.map((r) => {
              if (!r.cameras.some((c) => c.id === ev.camera_id)) return r;
              const cameras = r.cameras.map((c) => (c.id === ev.camera_id ? { ...c, state: ev.state, since: ev.since } : c));
              return { ...r, cameras, state: worstState(cameras.map((c) => c.state)) };
            });
            return { ...o, rooms, state: worstState(rooms.map((r) => r.state)) };
          });
          softRefresh();
          break;
        }
        case "incident_created":
        case "incident_merged":
        case "incident_updated":
          upsertIncident(data as Incident);
          softRefresh();
          break;
        case "alert": {
          const ev = data as AlertEvent;
          if (soundRef.current) playChime();
          setAlertPulse((n) => n + 1);
          pushToast({
            tone: "urgent",
            sticky: true,
            incidentId: ev.incident_id,
            title: `${eventLabel(ev.event_type)} — ${roomNameRef.current(ev.room_id)}`,
            body:
              eventTier(ev.event_type) === "urgent"
                ? "Check the area now and acknowledge. This is a prompt to look, not a finding."
                : "Check the clip or the area and acknowledge. This is a prompt to look, not a finding.",
            href: `/incidents/?id=${encodeURIComponent(ev.incident_id)}`,
          });
          softRefresh();
          void refreshIncidents();
          break;
        }
        case "incident_escalated": {
          const ev = data as EscalatedEvent;
          touched.current.set(ev.incident_id, ++clock.current);
          setIncidents((list) => list?.map((i) => (i.id === ev.incident_id ? { ...i, escalation_level: Math.max(i.escalation_level, ev.level) } : i)) ?? list);
          if (soundRef.current) playChime();
          pushToast({ tone: "urgent", title: `Alert escalated to level ${ev.level}`, body: "Not yet acknowledged.", href: `/incidents/?id=${encodeURIComponent(ev.incident_id)}`, incidentId: ev.incident_id });
          break;
        }
        case "alert_delivery_failed": {
          const ev = data as DeliveryFailedEvent;
          pushToast({ tone: "degraded", title: `Alert delivery failing (${ev.channel})`, body: ev.error || "A notification could not be delivered. Fallback channels are being used." });
          softRefresh();
          break;
        }
        default:
          break;
      }
      for (const h of handlers.current) h(type, data);
    },
    [pushToast, refreshIncidents, softRefresh, upsertIncident],
  );
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  // Live stream with our own reconnect/backoff so the "disconnected" state is explicit.
  // It reads the stream with fetch rather than EventSource: EventSource hides
  // `: ping` comments, and the pings are what tell a silent-but-healthy stream
  // from a dead connection (a sleeping laptop, a proxy that dropped it).
  useEffect(() => {
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;
    let lastSeen = 0;

    const fail = (c: AbortController) => {
      if (ctrl !== c || stopped) return;
      c.abort();
      ctrl = null;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      const at = Date.now() + delay;
      setLive((l) => ({ status: "down", downSince: l.downSince ?? Date.now(), reconnectAt: at }));
      // If the stream failed because the session ended, this triggers the 401 handler.
      api.get<Me>("/api/v1/me").catch(() => {});
      timer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = null;
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      lastSeen = Date.now();
      setLive((l) => ({ ...l, status: l.status === "down" ? "down" : "connecting", reconnectAt: null }));
      void (async () => {
        let res: Response;
        try {
          res = await fetch("/api/v1/events", { credentials: "same-origin", cache: "no-store", headers: { Accept: "text/event-stream" }, signal: c.signal });
        } catch {
          fail(c);
          return;
        }
        if (ctrl !== c) return;
        if (res.status === 401) notifyUnauthorized("/api/v1/events");
        if (!res.ok || !res.body) {
          fail(c);
          return;
        }
        attempt = 0;
        lastSeen = Date.now();
        setLive({ status: "open", downSince: null, reconnectAt: null });
        // Events are not replayed: always re-fetch everything after (re)connecting.
        void refreshAllRef.current();
        try {
          await readSse(res.body, c.signal, (type, data) => {
            lastSeen = Date.now();
            if (type === null) return; // comment (ping) or keep-alive
            if (!(SSE_TYPES as readonly string[]).includes(type)) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              return;
            }
            onEventRef.current(type as SseType, parsed);
          });
        } catch {
          /* aborted or network error */
        }
        fail(c); // the stream ended: the server closed it or the connection dropped
      })();
    };

    // A stream that has gone silent for two ping intervals is treated as dead.
    const checkLiveness = () => {
      if (stopped || !ctrl) return;
      if (Date.now() - lastSeen > SSE_LIVENESS_MS) fail(ctrl);
    };
    const liveness = setInterval(checkLiveness, LIVENESS_CHECK_MS);

    reconnectRef.current = () => {
      attempt = 0;
      connect();
    };
    const wake = () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (!ctrl) reconnectRef.current();
      else checkLiveness();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(liveness);
      ctrl?.abort();
      ctrl = null;
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  const subscribe = useCallback((h: SseHandler) => {
    handlers.current.add(h);
    return () => {
      handlers.current.delete(h);
    };
  }, []);

  const toggleSound = useCallback(async () => {
    if (soundRef.current) {
      soundRef.current = false;
      setSoundEnabled(false);
      disableSound();
      return;
    }
    const ok = await enableSound();
    soundRef.current = ok;
    setSoundEnabled(ok);
    if (!ok) pushToast({ tone: "degraded", title: "Alert sound could not be enabled", body: "This browser blocked audio. Check the device volume and site sound settings." });
  }, [pushToast]);

  const logout = useCallback(async () => {
    signedOut.current = true;
    try {
      await api.post("/api/v1/logout");
    } catch {
      /* ignore: we are leaving anyway */
    }
    onSignedOut(false);
  }, [onSignedOut]);

  const reconnectNow = useCallback(() => reconnectRef.current(), []);
  const sound = useMemo(() => ({ supported: soundOk, enabled: soundEnabled, toggle: toggleSound }), [soundOk, soundEnabled, toggleSound]);
  const value = useMemo<AppState>(() => ({
    me,
    can,
    overview,
    overviewAt,
    overviewError,
    incidents,
    incidentsError,
    refreshOverview,
    refreshIncidents,
    refreshAll,
    upsertIncident,
    showShadow,
    setShowShadow,
    live,
    reconnectNow,
    subscribe,
    toasts,
    pushToast,
    dismissToast,
    sound,
    logout,
    alertPulse,
  }), [me, can, overview, overviewAt, overviewError, incidents, incidentsError, refreshOverview, refreshIncidents, refreshAll, upsertIncident, showShadow, setShowShadow, live, reconnectNow, subscribe, toasts, pushToast, dismissToast, sound, logout, alertPulse]);

  return (
    <Ctx.Provider value={value}>
      <NowProvider>{children}</NowProvider>
    </Ctx.Provider>
  );
}

function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <NowCtx.Provider value={now}>{children}</NowCtx.Provider>;
}
