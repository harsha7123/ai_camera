// Thin fetch wrapper for the core API. Same-origin cookies; every POST is JSON
// (the core rejects anything else with 415 as part of its CSRF defence).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds from a Retry-After header (429 login lockout), when present. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type UnauthorizedHandler = (path: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Registered by the signed-in shell: a 401 anywhere means the session ended. */
export function setUnauthorizedHandler(h: UnauthorizedHandler | null) {
  onUnauthorized = h;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers:
        method === "POST"
          ? { "Content-Type": "application/json", Accept: "application/json" }
          : { Accept: "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the Zeoatap appliance. Check this device's network connection, then try again.");
  }
  if (res.status === 401 && path !== "/api/v1/login") {
    onUnauthorized?.(path);
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j && typeof j.error === "string" && j.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    const ra = Number(res.headers.get("Retry-After"));
    throw new ApiError(res.status, msg, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
};

/** Called by code that talks to the API outside `request` (the event stream). */
export function notifyUnauthorized(path: string) {
  onUnauthorized?.(path);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return `Your role does not allow this action (${e.message}). Ask the owner or an administrator if you need access.`;
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
}
