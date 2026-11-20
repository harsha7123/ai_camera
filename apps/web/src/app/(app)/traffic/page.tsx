"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RequirePermission } from "@/components/AdminOnly";
import { Icon } from "@/components/Icon";
import { EmptyState, ErrorState, Loading, PageHeader, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useApp } from "@/lib/store";
import { WEEKDAY_SHORT, hourLabel, zoneAbbrev } from "@/lib/time";
import { summarize, type TrafficSummary } from "@/lib/traffic";
import type { Traffic } from "@/lib/types";

const RANGES = [7, 14, 28] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Steps of the single-hue heat-map ramp (0 = no visitors). */
const LEVELS = 5;

function level(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0;
  return Math.min(LEVELS - 1, 1 + Math.floor(((n / max) * (LEVELS - 1)) - 1e-9));
}

function HeatMap({ s, tzName }: { s: TrafficSummary; tzName: string }) {
  return (
    <div className="table-wrap heatmap-wrap">
      <table className="heatmap" data-testid="heatmap">
        <caption className="sr-only">Visitors (entries) by day of week and hour, {tzName}. Darker cells mean more visitors; every cell shows its number.</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Day</span>
            </th>
            {s.hours.map((h) => (
              <th key={h} scope="col" className="hm-hour">
                {String(h).padStart(2, "0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEKDAY_SHORT.map((day, d) => (
            <tr key={day}>
              <th scope="row">{day}</th>
              {s.hours.map((h) => {
                const n = s.grid[d]![h]!;
                const isPeak = s.busiestSlot?.day === d && s.busiestSlot.hour === h;
                return (
                  <td
                    key={h}
                    className={`hm-cell hm-${level(n, s.max)}${isPeak ? " hm-peak" : ""}`}
                    title={`${day} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${n} ${n === 1 ? "visitor" : "visitors"}`}
                    data-testid="heat-cell"
                    data-day={d}
                    data-hour={h}
                    data-value={n}
                  >
                    {n}
                    {isPeak ? <span className="sr-only"> (busiest)</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <p className="stat-label">{label}</p>
      <p className="stat-value tabular">{value}</p>
      {sub ? <p className="muted small">{sub}</p> : null}
    </div>
  );
}

function TrafficInner() {
  const { overview } = useApp();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [camera, setCamera] = useState("all");
  const [data, setData] = useState<Traffic | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    try {
      setData(await api.get<Traffic>(`/api/v1/analytics/traffic?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [days]);
  useEffect(() => {
    // Fetch-on-mount: loads from the API (an external system); state is only set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const cameraName = useCallback(
    (id: string) => overview?.rooms.flatMap((r) => r.cameras).find((c) => c.id === id)?.name ?? id,
    [overview],
  );
  const cameras = useMemo(() => [...new Set(data?.buckets.map((b) => b.camera_id) ?? [])].sort(), [data]);
  const tz = data?.timezone ?? "UTC";
  const summary = useMemo(() => (data ? summarize(data.buckets.filter((b) => camera === "all" || b.camera_id === camera), tz) : null), [data, camera, tz]);
  const tzName = `${tz} (${zoneAbbrev(tz)})`;

  return (
    <>
      <PageHeader title="Traffic">
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          <Icon name="refresh" size={18} /> Refresh
        </button>
      </PageHeader>
      <div className="filters" role="group" aria-label="Traffic filters">
        <label className="field field-inline">
          <span>Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as (typeof RANGES)[number])} data-testid="traffic-range">
            {RANGES.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="field field-inline">
          <span>Camera</span>
          <select value={camera} onChange={(e) => setCamera(e.target.value)} data-testid="traffic-camera">
            <option value="all">All cameras</option>
            {cameras.map((c) => (
              <option key={c} value={c}>
                {cameraName(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && !data ? (
        <ErrorState title="Traffic could not be loaded" message={error} onRetry={() => void load()} />
      ) : !data || !summary ? (
        <Loading label="Loading traffic">
          <Skeleton lines={1} height={72} />
          <div style={{ height: 16 }} />
          <Skeleton lines={7} height={22} />
        </Loading>
      ) : data.buckets.length === 0 ? (
        <EmptyState title="No traffic counted in this period">Visitors are counted on cameras with a count line across the door. An administrator can add one under Cameras.</EmptyState>
      ) : (
        <>
          <div className="stats" data-testid="traffic-stats">
            <Stat testId="stat-visitors" label="Visitors (entries)" value={summary.visitors.toLocaleString()} sub={`${summary.exits.toLocaleString()} exits`} />
            <Stat
              testId="stat-busiest-hour"
              label="Busiest hour"
              value={summary.busiestHour ? `${hourLabel(summary.busiestHour.hour)}–${hourLabel((summary.busiestHour.hour + 1) % 24)}` : "—"}
              sub={summary.busiestHour ? `${summary.busiestHour.entries.toLocaleString()} visitors across the period` : "No entries counted"}
            />
            <Stat
              testId="stat-busiest-slot"
              label="Peak slot"
              value={summary.busiestSlot ? `${WEEKDAY_SHORT[summary.busiestSlot.day]} ${hourLabel(summary.busiestSlot.hour)}` : "—"}
              sub={summary.busiestSlot ? `${summary.busiestSlot.entries} visitors` : undefined}
            />
            <Stat testId="stat-peak-occupancy" label="Most people seen at once" value={String(summary.peakOccupancy)} sub="On a single camera" />
          </div>
          <section className="card" aria-labelledby="heat-h">
            <h2 id="heat-h">Peak hours</h2>
            <p className="muted small" data-testid="traffic-tz">
              Visitors by day and hour in the restaurant’s time ({tzName}), totalled over the last {days} days.
              {camera !== "all" && summary.visitors === 0 ? " This camera has no count line, so it records occupancy but not visitors." : ""}
            </p>
            <HeatMap s={summary} tzName={tzName} />
            <div className="hm-legend" aria-hidden="true">
              <span className="muted small">Fewer</span>
              {Array.from({ length: LEVELS }, (_, i) => (
                <span key={i} className={`hm-swatch hm-${i}`} />
              ))}
              <span className="muted small">More</span>
            </div>
          </section>
          <p className="muted small">
            Counts come from people crossing a line at the door; staff walking through are counted too. Nobody is identified: the system sees “a person”, never who.
          </p>
        </>
      )}
    </>
  );
}

export default function TrafficPage() {
  return (
    <RequirePermission perm="view_analytics">
      <TrafficInner />
    </RequirePermission>
  );
}
