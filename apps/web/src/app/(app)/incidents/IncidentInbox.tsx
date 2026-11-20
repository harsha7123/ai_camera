"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { AckButton } from "@/components/AckButton";
import { Icon } from "@/components/Icon";
import { Badge, EmptyState, ErrorState, Loading, PageHeader, SeverityBadge, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useApp } from "@/lib/store";
import { LIFECYCLE_SHORT, STATUS_LABEL, eventLabel, formatTime, humanize, needsAck, sortIncidents } from "@/lib/present";
import type { Incident, IncidentStatus } from "@/lib/types";

type LifecycleFilter = "open" | "all" | "resolved";

/** Builds an /incidents/ URL, keeping the area filter so it survives selecting a row. */
export function incidentsHref(id: string | null, room: string | null): string {
  const q = new URLSearchParams();
  if (room) q.set("room", room);
  if (id) q.set("id", id);
  const s = q.toString();
  return `/incidents/${s ? `?${s}` : ""}`;
}

function Row({ i, selected, roomName, room }: { i: Incident; selected: boolean; roomName: (id: string) => string; room: string | null }) {
  return (
    <li
      className={`inbox-row${selected ? " is-selected" : ""}${needsAck(i) && i.status === "ALERTED" ? " is-urgent" : ""}`}
      data-testid="incident-row"
      data-incident={i.id}
      data-lifecycle={i.lifecycle}
    >
      <Link href={incidentsHref(i.id, room)} className="inbox-link" aria-current={selected ? "true" : undefined}>
        <span className="inbox-top">
          <SeverityBadge incident={i} />
          <span className="tabular muted">{formatTime(i.start)}</span>
        </span>
        <span className="inbox-title">{eventLabel(i.event_type)}</span>
        {i.pos_ref ? <span className="inbox-meta muted">POS ticket {i.pos_ref}</span> : null}
        <span className="inbox-meta muted">
          {roomName(i.room_id)} · {humanize(i.room_zone)}
        </span>
        <span className="inbox-chips">
          <span className="chip">{LIFECYCLE_SHORT[i.lifecycle]}</span>
          <span className="chip">{STATUS_LABEL[i.status]}</span>
          {i.escalation_level > 0 ? <span className="chip chip-strong">Escalated · level {i.escalation_level}</span> : null}
          {i.legal_hold ? <span className="chip">Legal hold</span> : null}
          {i.source === "MOCK" ? <span className="chip">Test data</span> : null}
        </span>
      </Link>
      {needsAck(i) ? (
        <div className="inbox-ack">
          <AckButton incident={i} />
        </div>
      ) : null}
    </li>
  );
}

interface PosSearch {
  ref: string;
  results: Incident[] | null;
  error: string | null;
}

/**
 * The area filter lives in the URL (`?room=`), so links from the overview and
 * back/forward navigation always match what is shown.
 */
export function IncidentInbox({ selectedId, room: roomParam }: { selectedId: string | null; room: string | null }) {
  const router = useRouter();
  const { incidents, incidentsError, refreshIncidents, overview, can, showShadow, setShowShadow } = useApp();
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("open");
  const [status, setStatus] = useState<IncidentStatus | "all">("all");
  const room = roomParam ?? "all";
  const setRoom = (r: string) => router.replace(incidentsHref(selectedId, r === "all" ? null : r));
  const [posInput, setPosInput] = useState("");
  const [pos, setPos] = useState<PosSearch | null>(null);
  const posSeq = useRef(0);

  const roomName = (id: string) => overview?.rooms.find((r) => r.id === id)?.name ?? id;
  const rooms = useMemo(() => {
    const ids = new Set<string>([...(overview?.rooms.map((r) => r.id) ?? []), ...(incidents?.map((i) => i.room_id) ?? [])]);
    if (roomParam) ids.add(roomParam);
    return [...ids];
  }, [overview, incidents, roomParam]);

  const searchPos = async (e: FormEvent) => {
    e.preventDefault();
    const ref = posInput.trim();
    if (!ref) {
      setPos(null);
      return;
    }
    const seq = ++posSeq.current;
    setPos({ ref, results: null, error: null });
    try {
      const shadowQ = can("view_shadow") && showShadow ? "&shadow=1" : "";
      const results = await api.get<Incident[]>(`/api/v1/incidents?pos_ref=${encodeURIComponent(ref)}&limit=200${shadowQ}`);
      if (seq === posSeq.current) setPos({ ref, results, error: null });
    } catch (err) {
      if (seq === posSeq.current) setPos({ ref, results: null, error: errorMessage(err) });
    }
  };
  const clearPos = () => {
    posSeq.current++;
    setPos(null);
    setPosInput("");
  };

  const filtered = useMemo(() => {
    if (!incidents) return null;
    return sortIncidents(
      incidents.filter((i) => {
        if (lifecycle === "open" && i.lifecycle === "resolved") return false;
        if (lifecycle === "resolved" && i.lifecycle !== "resolved") return false;
        if (status !== "all" && i.status !== status) return false;
        if (room !== "all" && i.room_id !== room) return false;
        return true;
      }),
    );
  }, [incidents, lifecycle, status, room]);

  // Search results come from the server; show the live copy of each when the store has it.
  const posResults = useMemo(() => {
    if (!pos?.results) return null;
    const live = new Map((incidents ?? []).map((i) => [i.id, i]));
    return sortIncidents(pos.results.map((r) => ({ ...r, ...(live.get(r.id) ?? {}) })));
  }, [pos, incidents]);

  const pinned = filtered?.filter(needsAck) ?? [];
  const rest = filtered?.filter((i) => !needsAck(i)) ?? [];
  const statuses: IncidentStatus[] = ["ALERTED", "REVIEW_QUEUED", "INCONCLUSIVE", ...(can("view_shadow") && showShadow ? (["SHADOW"] as IncidentStatus[]) : [])];
  const filtersActive = lifecycle !== "open" || status !== "all" || room !== "all";

  return (
    <>
      <PageHeader title="Incidents">
        <span className="muted">AI flags, humans decide</span>
      </PageHeader>
      <form className="filters pos-search" role="search" aria-label="Find incidents by POS ticket" onSubmit={(e) => void searchPos(e)}>
        <label className="field field-inline">
          <span>POS ticket</span>
          <input
            type="search"
            value={posInput}
            onChange={(e) => setPosInput(e.target.value)}
            placeholder="e.g. T-1042"
            autoCapitalize="characters"
            spellCheck={false}
            data-testid="pos-search-input"
          />
        </label>
        <button type="submit" className="btn btn-secondary" data-testid="pos-search-submit">
          <Icon name="search" size={18} /> Find
        </button>
        {pos ? (
          <button type="button" className="btn btn-small" onClick={clearPos} data-testid="pos-search-clear">
            Clear search
          </button>
        ) : null}
      </form>
      <div className="filters" role="group" aria-label="Filter incidents">
        <label className="field field-inline">
          <span>Show</span>
          <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as LifecycleFilter)} data-testid="filter-lifecycle">
            <option value="open">Open (new + acknowledged)</option>
            <option value="all">All recent</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label className="field field-inline">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | "all")} data-testid="filter-status">
            <option value="all">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-inline">
          <span>Area</span>
          <select value={room} onChange={(e) => setRoom(e.target.value)} data-testid="filter-room">
            <option value="all">All areas</option>
            {rooms.map((r) => (
              <option key={r} value={r}>
                {roomName(r)}
              </option>
            ))}
          </select>
        </label>
        {can("view_shadow") ? (
          <label className="check shadow-toggle">
            <input
              type="checkbox"
              checked={showShadow}
              onChange={(e) => {
                setShowShadow(e.target.checked);
                if (!e.target.checked && status === "SHADOW") setStatus("all");
              }}
              data-testid="toggle-shadow"
            />
            <span>Include shadow-mode incidents (rules still being tuned; nobody is alerted)</span>
          </label>
        ) : null}
      </div>

      {pos ? (
        <section aria-labelledby="pos-h" className="inbox-section" data-testid="pos-results">
          <h2 id="pos-h" className="inbox-heading">
            POS ticket “{pos.ref}”{posResults ? ` · ${posResults.length} ${posResults.length === 1 ? "incident" : "incidents"}` : ""}
          </h2>
          {pos.error ? (
            <ErrorState title="Search failed" message={pos.error} />
          ) : !posResults ? (
            <Loading label="Searching">
              <Skeleton lines={2} />
            </Loading>
          ) : posResults.length === 0 ? (
            <EmptyState title="No incidents for this ticket">Check the ticket number on the receipt or in the POS. Only POS-linked incidents carry a ticket.</EmptyState>
          ) : (
            <ul className="inbox">
              {posResults.map((i) => (
                <Row key={i.id} i={i} selected={i.id === selectedId} roomName={roomName} room={roomParam} />
              ))}
            </ul>
          )}
        </section>
      ) : incidentsError && !incidents ? (
        <ErrorState title="Incidents could not be loaded" message={`${incidentsError} New alerts may still arrive through live updates.`} onRetry={() => void refreshIncidents()} />
      ) : filtered === null ? (
        <Loading label="Loading incidents">
          <ul className="inbox">
            {[0, 1, 2, 3].map((k) => (
              <li key={k} className="inbox-row">
                <Skeleton lines={3} />
              </li>
            ))}
          </ul>
        </Loading>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={filtersActive ? "No incidents match these filters" : "No open incidents"}
          action={
            filtersActive ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setLifecycle("open");
                  setStatus("all");
                  setRoom("all");
                }}
              >
                Clear filters
              </button>
            ) : null
          }
        >
          {filtersActive ? "Try a wider filter, such as “All recent”." : "Nothing is waiting for acknowledgement or review. Check the Overview for the monitoring status of each area."}
        </EmptyState>
      ) : (
        <>
          {pinned.length ? (
            <section aria-labelledby="pinned-h" className="inbox-section" data-testid="pinned-section">
              <h2 id="pinned-h" className="inbox-heading">
                <Badge tone="urgent" icon="triangle">
                  Unacknowledged · {pinned.length}
                </Badge>
              </h2>
              <ul className="inbox">
                {pinned.map((i) => (
                  <Row key={i.id} i={i} selected={i.id === selectedId} roomName={roomName} room={roomParam} />
                ))}
              </ul>
            </section>
          ) : null}
          {rest.length ? (
            <section aria-labelledby="rest-h" className="inbox-section">
              <h2 id="rest-h" className="inbox-heading">
                {lifecycle === "resolved" ? "Resolved" : pinned.length ? "Other incidents" : "Incidents"}
              </h2>
              <ul className="inbox">
                {rest.map((i) => (
                  <Row key={i.id} i={i} selected={i.id === selectedId} roomName={roomName} room={roomParam} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
