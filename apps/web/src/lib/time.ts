// Site-timezone helpers. Business hours, traffic and the access log are about
// the restaurant's local time (an IANA zone from the core), not the viewer's.

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const WEEKDAY_SHORT = WEEKDAYS;

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in `tz`. Falls back to UTC for an unknown zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = partsFmt(tz);
  } catch {
    fmt = partsFmt("UTC");
  }
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: Math.max(0, WEEKDAYS.indexOf(out.weekday as (typeof WEEKDAYS)[number])),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (positive east of UTC). */
function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant of local midnight at the start of `date` ("YYYY-MM-DD") in `tz`. */
export function zonedMidnight(date: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Two passes settle the offset across a DST change.
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return t;
}

/** "YYYY-MM-DD" for the instant in `tz`. */
export function zonedDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Adds whole days to a "YYYY-MM-DD" string (calendar arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Date and time of an instant, in the site's timezone. */
export function formatInZone(iso: string | null | undefined, tz: string, withSeconds = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Short zone name for display, e.g. "EST", or the IANA name if none. */
export function zoneAbbrev(tz: string, at = Date.now()): string {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(at));
    return p.find((x) => x.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

export function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}
