import { zonedParts } from "./time";
import type { TrafficBucket } from "./types";

export interface TrafficSummary {
  visitors: number;
  exits: number;
  peakOccupancy: number;
  /** grid[weekday 0=Mon][hour] = entries, in the site timezone */
  grid: number[][];
  max: number;
  busiestSlot: { day: number; hour: number; entries: number } | null;
  busiestHour: { hour: number; entries: number } | null;
  hours: number[];
}

/** Aggregates 15-minute buckets into a day-of-week × hour grid in `tz`. Visitors = entries. */
export function summarize(buckets: TrafficBucket[], tz: string): TrafficSummary {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const seenHours = new Set<number>();
  let visitors = 0;
  let exits = 0;
  let peakOccupancy = 0;
  for (const b of buckets) {
    const t = Date.parse(b.start);
    if (Number.isNaN(t)) continue;
    visitors += b.entries;
    exits += b.exits;
    peakOccupancy = Math.max(peakOccupancy, b.peak_occupancy);
    const p = zonedParts(t, tz);
    grid[p.weekday]![p.hour]! += b.entries;
    if (b.entries > 0 || b.peak_occupancy > 0) seenHours.add(p.hour);
  }
  let max = 0;
  let busiestSlot: TrafficSummary["busiestSlot"] = null;
  grid.forEach((row, day) =>
    row.forEach((n, hour) => {
      if (n > max) {
        max = n;
        busiestSlot = { day, hour, entries: n };
      }
    }),
  );
  let busiestHour: TrafficSummary["busiestHour"] = null;
  for (let h = 0; h < 24; h++) {
    const n = grid.reduce((s, row) => s + row[h]!, 0);
    if (n > 0 && (!busiestHour || n > busiestHour.entries)) busiestHour = { hour: h, entries: n };
  }
  const hs = [...seenHours].sort((a, b) => a - b);
  const hours = hs.length ? Array.from({ length: hs[hs.length - 1]! - hs[0]! + 1 }, (_, i) => hs[0]! + i) : Array.from({ length: 24 }, (_, i) => i);
  return { visitors, exits, peakOccupancy, grid, max, busiestSlot, busiestHour, hours };
}

