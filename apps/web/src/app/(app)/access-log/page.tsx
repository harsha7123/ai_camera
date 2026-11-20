"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RequirePermission } from "@/components/AdminOnly";
import { Icon } from "@/components/Icon";
import { Badge, EmptyState, ErrorState, Loading, PageHeader, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useApp, useNow } from "@/lib/store";
import { durationSeconds, humanize } from "@/lib/present";
import { addDays, browserTimezone, formatInZone, zoneAbbrev, zonedDate, zonedMidnight } from "@/lib/time";
import type { ZoneAccess } from "@/lib/types";

const LIMIT = 1000;

function formatDuration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function AccessLogInner() {
  const { overview } = useApp();
  const now = useNow();
  const tz = overview?.business?.timezone ?? browserTimezone();
  // Date filters are calendar days in the restaurant's timezone, inclusive.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const today = zonedDate(now, tz);
  const from = range?.from ?? addDays(today, -6);
  const to = range?.to ?? today;
  const [afterOnly, setAfterOnly] = useState(false);
  const [rows, setRows] = useState<ZoneAccess[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rangeError = from > to ? "The start date is after the end date." : null;
  const fromMs = zonedMidnight(from, tz);
  const toMs = zonedMidnight(addDays(to, 1), tz);

  const load = useCallback(async () => {
    if (fromMs === null || toMs === null || fromMs >= toMs) return;
    try {
      const q = `from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}&limit=${LIMIT}`;
      setRows(await api.get<ZoneAccess[]>(`/api/v1/access-log?${q}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [fromMs, toMs]);
  useEffect(() => {
    // Fetch-on-mount and on filter change: loads from the API; state is only set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const roomName = (id: string) => overview?.rooms.find((r) => r.id === id)?.name ?? humanize(id);
  const cameraName = (id: string) => overview?.rooms.flatMap((r) => r.cameras).find((c) => c.id === id)?.name ?? id;
  const shown = useMemo(() => rows?.filter((r) => !afterOnly || r.after_hours) ?? null, [rows, afterOnly]);
  const afterCount = rows?.filter((r) => r.after_hours).length ?? 0;

  return (
    <>
      <PageHeader title="Access log">
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          <Icon name="refresh" size={18} /> Refresh
        </button>
      </PageHeader>
      <p className="muted">
        Visits to secure areas: safe, cash office, walk-in cooler and back door. Each row is one tracked person, not an identified individual. “Staff” is inferred from
        time spent in staff areas, never from faces.
      </p>
      <div className="filters" role="group" aria-label="Filter the access log">
        <label className="field field-inline">
          <span>From</span>
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setRange({ from: e.target.value, to })} data-testid="access-from" />
        </label>
        <label className="field field-inline">
          <span>To</span>
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setRange({ from, to: e.target.value })} data-testid="access-to" />
        </label>
        <label className="check">
          <input type="checkbox" checked={afterOnly} onChange={(e) => setAfterOnly(e.target.checked)} data-testid="access-after-only" />
          <span>After hours only</span>
        </label>
        <span className="muted small">Times in {tz} ({zoneAbbrev(tz)})</span>
      </div>
      {rangeError ? (
        <p className="notice notice-error" role="alert">
          {rangeError}
        </p>
      ) : error && !rows ? (
        <ErrorState title="The access log could not be loaded" message={error} onRetry={() => void load()} />
      ) : !shown ? (
        <Loading label="Loading the access log">
          <Skeleton lines={8} height={22} />
        </Loading>
      ) : shown.length === 0 ? (
        <EmptyState title={afterOnly ? "No after-hours visits in this period" : "No visits in this period"}>Try a wider date range.</EmptyState>
      ) : (
        <div className="card table-wrap">
          <p className="small" data-testid="access-summary" role="status">
            {shown.length} {shown.length === 1 ? "visit" : "visits"}
            {afterOnly ? "" : ` · ${afterCount} after hours`}
            {rows && rows.length >= LIMIT ? ` · showing the newest ${LIMIT}; narrow the dates to see older visits` : ""}
          </p>
          <table className="table" data-testid="access-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Area</th>
                <th scope="col">Zone</th>
                <th scope="col">Who</th>
                <th scope="col">Duration</th>
                <th scope="col">Hours</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} data-testid="access-row" data-after-hours={r.after_hours ? "true" : "false"} className={r.after_hours ? "row-after-hours" : undefined}>
                  <td className="tabular small">{formatInZone(r.start, tz)}</td>
                  <td>
                    {roomName(r.room_id)}
                    <div className="muted small">{cameraName(r.camera_id)}</div>
                  </td>
                  <td>{humanize(r.room_zone)}</td>
                  <td>{r.role === "staff" ? "Staff (inferred)" : "Person not recognised as staff"}</td>
                  <td className="tabular">{formatDuration(durationSeconds(r.start, r.end))}</td>
                  <td>
                    {r.after_hours ? (
                      <Badge tone="degraded" icon="triangle">
                        After hours
                      </Badge>
                    ) : (
                      <span className="muted">Staff hours</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function AccessLogPage() {
  return (
    <RequirePermission perm="view_access_log">
      <AccessLogInner />
    </RequirePermission>
  );
}
