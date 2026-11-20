// Remembers (per tab) that this tab had a session, so a later 401 can be
// explained as "your session expired" rather than a plain sign-in prompt.
const FLAG = "zeoatap_signed_in";

export function markSignedIn(v: boolean) {
  try {
    if (v) sessionStorage.setItem(FLAG, "1");
    else sessionStorage.removeItem(FLAG);
  } catch {
    /* storage unavailable */
  }
}

export function wasSignedIn(): boolean {
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

// Backslashes are treated as "/" by URL parsers ("/\\evil.example" is a
// protocol-relative URL), and control characters (tab, newline) are stripped
// before parsing, so neither may appear in a post-login destination.
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

/**
 * Only allow same-origin paths as post-login destinations. The value is
 * parsed against the current origin and rejected unless it stays on it.
 */
export function safeNext(next: string | null, origin: string = typeof window === "undefined" ? "http://localhost" : window.location.origin): string {
  if (!next || UNSAFE_CHARS.test(next) || !next.startsWith("/") || next.startsWith("//")) return "/";
  let u: URL;
  try {
    u = new URL(next, origin);
  } catch {
    return "/";
  }
  if (u.origin !== origin) return "/";
  const path = `${u.pathname}${u.search}${u.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || path === "/login" || path.startsWith("/login/") || path.startsWith("/login?")) return "/";
  return path;
}
