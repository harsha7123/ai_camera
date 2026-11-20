import type { Zone, ZoneKind } from "./types";

export const ZONE_KINDS: readonly ZoneKind[] = ["restricted", "secure", "staff_area", "queue", "post", "customer_side", "floor", "count_line"];

/** What each zone kind is used for (API.md v2). */
export const ZONE_KIND_HINT: Record<ZoneKind, string> = {
  restricted: "Office or similar: review prompt if someone not recognised as staff stays 3 s",
  secure: "Safe, cash office, walk-in cooler, back door: access log + review prompt for non-staff",
  staff_area: "Behind the counter: time spent here is how staff are inferred (no faces)",
  queue: "Where customers line up: long queue / long wait",
  post: "Register, host stand: unattended post during business hours",
  customer_side: "In front of a register: checked for POS voids/refunds with no customer",
  floor: "Floor area for possible slip/fall (person down)",
  count_line: "A line (exactly 2 points) across a door for visitor counts",
};

export type ZoneValidation = { ok: true; zones: Zone[] } | { ok: false; errors: string[] };

/** Validates the zones JSON typed by an admin. Coordinates are normalised (0..1). */
export function validateZonesJson(text: string): ZoneValidation {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, zones: [] };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!Array.isArray(data)) return { ok: false, errors: ["Zones must be a JSON array, e.g. [{\"id\": \"reg1-front\", ...}]."] };
  const errors: string[] = [];
  const ids = new Set<string>();
  data.forEach((z: unknown, i: number) => {
    const where = `Zone ${i + 1}`;
    if (typeof z !== "object" || z === null || Array.isArray(z)) {
      errors.push(`${where}: must be an object.`);
      return;
    }
    const o = z as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.trim() === "") errors.push(`${where}: "id" must be a non-empty string.`);
    else if (ids.has(o.id)) errors.push(`${where}: duplicate id "${o.id}".`);
    else ids.add(o.id);
    if (typeof o.room_zone !== "string" || o.room_zone.trim() === "") errors.push(`${where}: "room_zone" must be a non-empty string (the area-level zone this maps to, e.g. register-1).`);
    const kindOk = typeof o.kind === "string" && (ZONE_KINDS as readonly string[]).includes(o.kind);
    if (!kindOk) errors.push(`${where}: "kind" must be one of ${ZONE_KINDS.join(", ")}.`);
    const isLine = o.kind === "count_line";
    if (!Array.isArray(o.polygon)) {
      errors.push(`${where}: "polygon" must be an array of points.`);
    } else if (isLine && o.polygon.length !== 2) {
      errors.push(`${where}: a count_line needs exactly 2 points (the line visitors cross).`);
    } else if (!isLine && o.polygon.length < 3) {
      errors.push(`${where}: "polygon" needs at least 3 points.`);
    } else {
      o.polygon.forEach((p: unknown, j: number) => {
        const q = p as Record<string, unknown> | null;
        const ok =
          q !== null && typeof q === "object" && typeof q.X === "number" && typeof q.Y === "number" && q.X >= 0 && q.X <= 1 && q.Y >= 0 && q.Y <= 1;
        if (!ok) errors.push(`${where}, point ${j + 1}: must be {"X": n, "Y": n} with values between 0 and 1.`);
      });
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, zones: data as Zone[] };
}

export const ZONES_EXAMPLE = JSON.stringify(
  [
    {
      id: "reg2-staff",
      room_zone: "register-2",
      kind: "post",
      polygon: [
        { X: 0.3, Y: 0.0 },
        { X: 0.7, Y: 0.0 },
        { X: 0.7, Y: 0.35 },
        { X: 0.3, Y: 0.35 },
      ],
    },
    {
      id: "reg2-front",
      room_zone: "register-2-front",
      kind: "customer_side",
      polygon: [
        { X: 0.25, Y: 0.45 },
        { X: 0.75, Y: 0.45 },
        { X: 0.75, Y: 0.7 },
        { X: 0.25, Y: 0.7 },
      ],
    },
  ],
  null,
  2,
);
