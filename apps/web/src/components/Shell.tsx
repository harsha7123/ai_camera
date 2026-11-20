"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { MonitoringBanner } from "./MonitoringBanner";
import { ThemeToggle } from "./ThemeToggle";
import { Toasts } from "./Toasts";
import { isStale, useApp, useNow } from "@/lib/store";
import { ROLE_LABEL, ageSeconds, formatAge } from "@/lib/present";
import { zonedParts } from "@/lib/time";
import type { Overview, Permission } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  /** data-testid suffix */
  id: string;
  icon: "home" | "inbox" | "camera" | "users" | "log" | "chart" | "key";
  perm: Permission;
}

const NAV: NavItem[] = [
  { href: "/", label: "Overview", id: "overview", icon: "home", perm: "view_status" },
  { href: "/incidents/", label: "Incidents", id: "incidents", icon: "inbox", perm: "view_status" },
  { href: "/traffic/", label: "Traffic", id: "traffic", icon: "chart", perm: "view_analytics" },
  { href: "/access-log/", label: "Access log", id: "access-log", icon: "key", perm: "view_access_log" },
  { href: "/cameras/", label: "Cameras", id: "cameras", icon: "camera", perm: "admin" },
  { href: "/users/", label: "Users", id: "users", icon: "users", perm: "admin" },
  { href: "/audit/", label: "Audit", id: "audit", icon: "log", perm: "admin" },
];

function isActive(path: string, href: string) {
  const p = path.endsWith("/") ? path : `${path}/`;
  return href === "/" ? p === "/" : p.startsWith(href);
}

function LiveIndicator() {
  const { live, reconnectNow } = useApp();
  const now = useNow();
  if (live.status === "open") {
    return (
      <span className="live live-ok" data-testid="live-indicator" data-status="open">
        <Icon name="live" size={18} /> <span>Live</span>
      </span>
    );
  }
  if (live.status === "connecting") {
    return (
      <span className="live live-wait" data-testid="live-indicator" data-status="connecting">
        <Icon name="question" size={18} /> <span>Connecting…</span>
      </span>
    );
  }
  const retryIn = live.reconnectAt ? Math.max(0, Math.ceil((live.reconnectAt - now) / 1000)) : 0;
  return (
    <span className="live live-down" data-testid="live-indicator" data-status="down" role="status">
      <Icon name="unplug" size={18} />
      <span>
        Live updates disconnected{live.downSince ? ` (${formatAge(ageSeconds(live.downSince, now))})` : ""}
        <span className="live-retry">{retryIn > 0 ? ` · retrying in ${retryIn}s` : " · retrying…"}</span>
      </span>
      <button type="button" className="btn btn-small" onClick={reconnectNow}>
        Retry now
      </button>
    </span>
  );
}

function FacilitySummary() {
  const { overview, overviewAt, live } = useApp();
  const now = useNow();
  if (!overview) return <span className="muted">Loading status…</span>;
  const total = overview.rooms.length;
  const ok = overview.rooms.filter((r) => r.state === "FULLY_OPERATIONAL").length;
  const stale = isStale(overviewAt, live.status, now);
  return (
    <span className="facility-summary" data-testid="facility-summary">
      {stale ? (
        <span className="summary-unknown">
          <Icon name="question" size={16} /> Status unknown
        </span>
      ) : (
        <span>
          {ok}/{total} areas fully monitored
        </span>
      )}
    </span>
  );
}

/** "Open · closes 22:00" / "Closed · opens 11:00". `open` comes from the core; the times are site-local. */
export function businessText(b: NonNullable<Overview["business"]>, now: number): string {
  const p = zonedParts(now, b.timezone);
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  if (b.open) {
    const span = b.today.find(([o, c]) => o <= hhmm && (hhmm < c || c < o));
    return span ? `Open · closes ${span[1]}` : "Open";
  }
  const next = b.today.find(([o]) => o > hhmm);
  return next ? `Closed · opens ${next[0]}` : "Closed";
}

function BusinessStatus() {
  const { overview } = useApp();
  const now = useNow();
  const b = overview?.business;
  if (!b) return null;
  return (
    <span className={`biz ${b.open ? "biz-open" : "biz-closed"}`} data-testid="business-status" data-open={b.open ? "true" : "false"} title={`Business hours, ${b.timezone}`}>
      <Icon name="store" size={18} />
      <span>{businessText(b, now)}</span>
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, can, overview, sound, logout, alertPulse } = useApp();
  const path = usePathname() ?? "/";
  const items = NAV.filter((n) => can(n.perm));
  const openAlerts = overview?.open_alerts ?? null;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <MonitoringBanner />
      <header className="topbar">
        {alertPulse ? <span className="alert-pulse" key={alertPulse} aria-hidden="true" data-testid="alert-pulse" /> : null}
        <div className="topbar-left">
          <Link href="/" className="brand" aria-label="Restaurant overview">
            <span className="brand-mark" aria-hidden="true">
              Z
            </span>
            <span className="brand-text">
              <span className="brand-facility">{overview?.facility.name ?? "Restaurant Watchdog"}</span>
              <FacilitySummary />
            </span>
          </Link>
        </div>
        <div className="topbar-right">
          <Link href="/incidents/" className={`alerts-pill${openAlerts ? " has-open" : ""}`} data-testid="open-alerts">
            <span className="alerts-pill-label">Open alerts</span>
            <span className="alerts-pill-count">{openAlerts ?? "–"}</span>
          </Link>
          <BusinessStatus />
          <LiveIndicator />
          {sound.supported ? (
            // A toggle button: the accessible name stays "Alert sound" and aria-pressed carries the state.
            <button
              type="button"
              className={`btn ${sound.enabled ? "btn-secondary" : "btn-attention"}`}
              onClick={() => void sound.toggle()}
              aria-pressed={sound.enabled}
              aria-label="Alert sound"
              data-testid="sound-toggle"
            >
              <Icon name={sound.enabled ? "sound" : "mute"} size={18} />
              <span className="hide-sm" aria-hidden="true">
                {sound.enabled ? "Alert sound on" : "Alert sound off"}
              </span>
              <span className="show-sm" aria-hidden="true">
                Sound
              </span>
            </button>
          ) : null}
          <ThemeToggle />
          <div className="user-chip" data-testid="user-chip">
            <span className="user-name">{me.user.display_name}</span>
            <span className="user-role">{ROLE_LABEL[me.user.role] ?? me.user.role}</span>
          </div>
          <button type="button" className="icon-btn" onClick={() => void logout()} aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <div className="body">
        <nav className="sidenav" aria-label="Main">
          <ul>
            {items.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="nav-link" aria-current={isActive(path, n.href) ? "page" : undefined} data-testid={`nav-${n.id}`}>
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                  {n.href === "/incidents/" && openAlerts ? <span className="nav-count">{openAlerts}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav className="bottomnav" aria-label="Main (compact)">
        {items.map((n) => (
          <Link key={n.href} href={n.href} className="bottomnav-link" aria-current={isActive(path, n.href) ? "page" : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.href === "/incidents/" && openAlerts ? <span className="nav-count">{openAlerts}</span> : null}
          </Link>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
