#!/usr/bin/env node
// End-to-end tests: static export (./out) served by the mock core + Chromium.
//   npx next build && node e2e/run.mjs            (optional: --only <substring>)

import assert from "node:assert/strict";
import { launch, login, startMock, PASSWORD, USERS } from "./harness.mjs";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const T = [];
const test = (name, fn) => T.push({ name, fn });

const mock = await startMock({ port: 8190, pingMs: 2000 });
const browser = await launch();
const base = mock.base;
const SITE_TZ = "America/New_York";

async function fresh(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

const tileTones = (page) =>
  page.$$eval('[data-testid="room-tile"]', (els) => els.map((e) => ({ room: e.getAttribute("data-room"), state: e.getAttribute("data-state"), tone: e.getAttribute("data-tone") })));

/** Green (tone ok) must only ever appear with state FULLY_OPERATIONAL. */
async function assertNeverFalseGreen(page) {
  const tones = await tileTones(page);
  for (const t of tones) if (t.tone === "ok") assert.equal(t.state, "FULLY_OPERATIONAL", `area ${t.room} shown green in state ${t.state}`);
  const camRows = await page.$$eval('[data-testid="room-tile"] .cam-state', (els) => els.map((e) => e.getAttribute("data-tone")));
  const anyStale = tones.some((t) => t.state === "UNKNOWN");
  if (anyStale) assert.ok(camRows.every((t) => t === "unknown"), "no green camera rows while stale");
  const badges = await page.$$eval('[data-testid="state-badge"]', (els) => els.map((e) => ({ tone: e.getAttribute("data-tone"), text: e.textContent })));
  for (const b of badges) if (b.tone === "ok") assert.match(b.text ?? "", /Fully monitored/);
  return tones;
}

/** POST from inside the page (same-origin cookie), e.g. another user's action. */
const pagePost = (page, path, body = {}) =>
  page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      return r.status;
    },
    [path, body],
  );

/** "YYYY-MM-DD" in the site timezone, `daysAgo` calendar days back. */
function siteDate(daysAgo) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = f.format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ sign-in

test("login per role, and bad password", async () => {
  for (const role of Object.keys(USERS)) {
    const { ctx, page, errors } = await fresh();
    await login(page, base, role);
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const { ctx, page } = await fresh();
  await page.goto(`${base}/login/`);
  await page.getByLabel("Username").fill("jo");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("login-error").waitFor();
  assert.match(await page.getByTestId("login-error").innerText(), /Incorrect username or password/);
  await ctx.close();
});

test("login lockout after 5 failures shows the lockout message (429)", async () => {
  const { ctx, page } = await fresh();
  await page.goto(`${base}/login/`);
  await page.getByLabel("Username").fill("sam");
  await page.getByLabel("Password").fill("wrong-password");
  for (let i = 0; i < 5; i++) {
    const resp = page.waitForResponse((r) => r.url().endsWith("/api/v1/login"));
    await page.getByRole("button", { name: "Sign in" }).click();
    assert.equal((await resp).status(), 401);
    await page.getByRole("button", { name: "Sign in" }).and(page.locator(":not([disabled])")).waitFor();
  }
  // Even the right password is refused while the account is locked.
  await page.getByLabel("Password").fill(PASSWORD);
  const resp = page.waitForResponse((r) => r.url().endsWith("/api/v1/login"));
  await page.getByRole("button", { name: "Sign in" }).click();
  assert.equal((await resp).status(), 429);
  await page.getByTestId("login-error").filter({ hasText: "Too many failed sign-in attempts" }).waitFor();
  assert.match(await page.getByTestId("login-error").innerText(), /locked for about 15 minutes/);
  const s = await mock.state();
  assert.equal(s.audit.filter((a) => a.action === "login_locked" && a.subject === "sam").length, 1, "the lock is audited once");
  await ctx.close();
});

test("open-redirect attempts after sign-in stay on site", async () => {
  const attempts = ["/\\evil.example", "/%5Cevil.example", "//evil.example", "https://evil.example/", "/\t/evil.example", "javascript:alert(1)"];
  for (const next of attempts) {
    const { ctx, page } = await fresh();
    await page.goto(`${base}/login/?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Username").fill("jo");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByTestId("user-chip").waitFor({ state: "attached" });
    const u = new URL(page.url());
    assert.equal(u.origin, base, `next=${JSON.stringify(next)} must stay on ${base}`);
    assert.equal(u.pathname, "/", `next=${JSON.stringify(next)} goes to the overview`);
    await ctx.close();
  }
  // A genuine same-site destination is kept.
  const { ctx, page } = await fresh();
  await page.goto(`${base}/login/?next=${encodeURIComponent("/incidents/?id=INC-7f3a9c21b001")}`);
  await page.getByLabel("Username").fill("jo");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator('[data-testid="incident-detail"][data-incident="INC-7f3a9c21b001"]').waitFor();
  await ctx.close();
});

test("unauthenticated visit redirects to login (no expiry message)", async () => {
  const { ctx, page } = await fresh();
  await page.goto(`${base}/incidents/`);
  await page.waitForURL(/\/login\//);
  assert.equal(await page.getByTestId("session-expired").count(), 0);
  await ctx.close();
});

test("normal sign-out does not set next=", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.goto(`${base}/incidents/`);
  await page.getByTestId("incident-row").first().waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login\//);
  const u = new URL(page.url());
  assert.equal(u.searchParams.get("next"), null, "no next= after a normal sign-out");
  assert.equal(u.searchParams.get("expired"), null);
  await ctx.close();
});

test("nav visibility per role; permission gate names the missing permission", async () => {
  const expected = {
    staff: ["overview", "incidents"],
    manager: ["overview", "incidents", "traffic", "access-log"],
    owner: ["overview", "incidents", "traffic", "access-log"],
    admin: ["overview", "incidents", "cameras", "users", "audit"],
  };
  for (const [role, items] of Object.entries(expected)) {
    const { ctx, page } = await fresh();
    await login(page, base, role);
    const shown = await page.$$eval('[data-testid^="nav-"]', (els) => els.map((e) => e.getAttribute("data-testid").slice(4)));
    assert.deepEqual(shown, items, `nav for ${role}`);
    if (role !== "admin") {
      await page.goto(`${base}/audit/`);
      const gate = page.locator('[data-testid="permission-gate"][data-permission="admin"]');
      await gate.waitFor();
      assert.match(await gate.innerText(), /“Administration” permission/);
    }
    if (role === "staff" || role === "admin") {
      await page.goto(`${base}/traffic/`);
      const gate = page.locator('[data-testid="permission-gate"][data-permission="view_analytics"]');
      await gate.waitFor();
      assert.match(await gate.innerText(), /View traffic analytics/);
      await page.goto(`${base}/access-log/`);
      await page.locator('[data-testid="permission-gate"][data-permission="view_access_log"]').waitFor();
    }
    await ctx.close();
  }
});

// ------------------------------------------------------------------ status (safety)

test("banner lists non-operational areas; never green when degraded", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  const banner = page.getByTestId("monitoring-banner");
  await banner.waitFor();
  const text = await banner.innerText();
  for (const r of ["Front counter", "Dining room", "Kitchen", "Patio"]) assert.ok(text.includes(r), `banner mentions ${r}`);
  assert.ok(!text.includes("Entrance"), "banner must not list the fully operational area");
  assert.match(text, /Alert delivery failing/);
  assert.match(text, /4 areas affected/);
  assert.equal(await banner.getByRole("button").count(), 0, "banner has no dismiss control");
  await page.getByTestId("room-tile").first().waitFor();
  const tones = await assertNeverFalseGreen(page);
  const byRoom = Object.fromEntries(tones.map((t) => [t.room, t]));
  assert.equal(byRoom.entrance.tone, "ok");
  assert.equal(byRoom.back.tone, "ok");
  assert.equal(byRoom.counter.tone, "degraded");
  assert.equal(byRoom.dining.tone, "unavailable");
  assert.equal(byRoom.kitchen.tone, "unavailable");
  assert.equal(byRoom.patio.state, "NOT_CONNECTED");
  assert.match(await page.getByTestId("staleness").first().innerText(), /Last update \d+s ago/);
  assert.match(await page.getByTestId("human-decides").innerText(), /AI flags, humans decide/);

  // live camera_state event turns the green area red without reload
  await mock.control("camera_state", { camera_id: "cam-entrance", state: "CAMERA_UNAVAILABLE" });
  await page.locator('[data-room="entrance"][data-tone="unavailable"]').waitFor({ timeout: 5000 });
  assert.ok((await banner.innerText()).includes("Entrance"));
  await assertNeverFalseGreen(page);
  await ctx.close();
});

test("banner live region exists before any warning appears", async () => {
  await mock.control("reset", { scenario: "all_ok" });
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.getByTestId("room-tile").first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="monitoring-banner"]'));
  const region = page.getByTestId("banner-region");
  assert.equal(await region.getAttribute("aria-live"), "polite", "the live region is already in the DOM while there is nothing to announce");
  await mock.control("camera_state", { camera_id: "cam-kitchen", state: "VIDEO_DEGRADED" });
  await region.getByTestId("monitoring-banner").waitFor({ timeout: 5000 });
  assert.equal(await page.locator('[data-testid="monitoring-banner"] [aria-live]').count(), 0, "no nested live regions");
  await ctx.close();
});

test("all operational: no banner, green tiles", async () => {
  await mock.control("reset", { scenario: "all_ok" });
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.getByTestId("room-tile").first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="monitoring-banner"]'));
  const tones = await assertNeverFalseGreen(page);
  assert.ok(tones.length >= 5 && tones.every((t) => t.tone === "ok"));
  await ctx.close();
});

test("stream down: stale banner, nothing green, disconnected indicator, re-fetch after reconnect", async () => {
  await mock.control("reset", { scenario: "all_ok" });
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.getByTestId("room-tile").first().waitFor();
  await mock.control("sse/drop", { refuse_ms: 4000 });
  const ind = page.locator('[data-testid="live-indicator"][data-status="down"]');
  await ind.waitFor({ timeout: 5000 });
  assert.match(await ind.innerText(), /Live updates disconnected/);
  await page.getByTestId("banner-stale").waitFor();
  const tones = await assertNeverFalseGreen(page);
  assert.ok(tones.every((t) => t.state === "UNKNOWN" && t.tone === "unknown"), "all tiles unknown while stream is down");
  // an incident created while disconnected is never pushed; it must appear via re-fetch after reconnect
  const inc = await mock.control("incident", { room_id: "entrance", room_zone: "front-door", event_type: "after_hours_intrusion", cameras: ["cam-entrance"], silent: true });
  await page.locator('[data-testid="live-indicator"][data-status="open"]').waitFor({ timeout: 20_000 });
  await page.locator(`[data-testid="attention-item"][data-incident="${inc.id}"]`).waitFor({ timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="monitoring-banner"]'));
  await ctx.close();
});

test("silent stream (no pings for 2 intervals) is treated as dead and reconnected", async () => {
  await mock.control("reset", { scenario: "all_ok" });
  const { ctx, page } = await fresh();
  await page.clock.install();
  await login(page, base, "staff");
  await page.getByTestId("room-tile").first().waitFor();
  const before = (await mock.state()).sse_connects;
  const stalled = await mock.control("sse/stall");
  assert.ok(stalled.stalled >= 1, "the page's stream is open");
  // The connection stays open but nothing arrives; jump past the liveness window (2 × 15 s ping + margin).
  await page.clock.fastForward(40_000);
  for (let i = 0; i < 50 && (await mock.state()).sse_connects <= before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok((await mock.state()).sse_connects > before, "client opened a new stream");
  await page.locator('[data-testid="live-indicator"][data-status="open"]').waitFor({ timeout: 10_000 });
  await ctx.close();
});

test("engine error: areas shown as AI unavailable, never green", async () => {
  await mock.control("reset", { scenario: "all_ok" });
  await mock.control("services", { engine: "error", engine_error: "worker heartbeat lost" });
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.getByTestId("room-tile").first().waitFor();
  await page.locator('[data-testid="banner-service"]', { hasText: "worker heartbeat lost" }).waitFor();
  const tones = await assertNeverFalseGreen(page);
  assert.ok(tones.every((t) => t.state === "AI_UNAVAILABLE"));
  await ctx.close();
});

test("business open/closed indicator in the top bar", async () => {
  await mock.control("business", { open: true });
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  const biz = page.getByTestId("business-status");
  await biz.waitFor();
  assert.equal(await biz.getAttribute("data-open"), "true");
  assert.match(await biz.innerText(), /^Open/);
  await mock.control("business", { open: false });
  await page.locator('[data-testid="business-status"][data-open="false"]').waitFor({ timeout: 8000 });
  assert.match(await biz.innerText(), /^Closed/);
  await ctx.close();
});

// ------------------------------------------------------------------ incidents

test("one-tap acknowledge", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  const item = page.locator('[data-testid="attention-item"][data-incident="INC-7f3a9c21b001"]');
  await item.waitFor();
  const t0 = Date.now();
  await item.getByTestId("ack-button").click();
  await item.waitFor({ state: "detached", timeout: 3000 });
  const elapsed = Date.now() - t0;
  const s = await mock.state();
  const inc = s.incidents.find((i) => i.id === "INC-7f3a9c21b001");
  assert.equal(inc.lifecycle, "acknowledged");
  assert.equal(inc.acknowledged_by, "jo");
  await page.goto(`${base}/incidents/?id=INC-7f3a9c21b001`);
  await page.getByTestId("ack-info").waitFor();
  assert.match(await page.getByTestId("ack-info").innerText(), /Acknowledged by jo/);
  console.log(`    (ack round-trip in UI: ${elapsed} ms)`);
  await ctx.close();
});

test("acknowledge from incident inbox (pinned section)", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "manager");
  await page.getByTestId("nav-incidents").click();
  const pinned = page.getByTestId("pinned-section");
  await pinned.waitFor();
  assert.equal(await pinned.getByTestId("incident-row").count(), 1);
  await pinned.getByTestId("ack-button").click();
  await pinned.waitFor({ state: "detached" });
  await page.locator('[data-incident="INC-7f3a9c21b001"][data-lifecycle="acknowledged"]').waitFor();
  await ctx.close();
});

test("stale incident refresh never overwrites a newer live update", async () => {
  const other = await fresh();
  await login(other.page, base, "manager");
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.goto(`${base}/incidents/`);
  await page.locator('[data-testid="incident-row"][data-incident="INC-7f3a9c21b001"][data-lifecycle="new"]').waitFor();
  // The next list refresh snapshots the server state, then replies 1.5 s later.
  await mock.control("incidents_delay", { ms: 1500 });
  const req = page.waitForRequest((r) => r.url().includes("/api/v1/incidents?open=1"));
  const resp = page.waitForResponse((r) => r.url().includes("/api/v1/incidents?open=1"));
  await mock.control("emit", { type: "alert", data: { incident_id: "INC-zz", room_id: "counter", event_type: "long_queue", level: 0 } }); // triggers a refresh
  await req;
  await new Promise((r) => setTimeout(r, 200)); // the snapshot has been taken
  assert.equal(await pagePost(other.page, "/api/v1/incidents/INC-7f3a9c21b001/ack"), 200);
  await page.locator('[data-testid="incident-row"][data-incident="INC-7f3a9c21b001"][data-lifecycle="acknowledged"]').waitFor({ timeout: 3000 });
  await resp; // the stale snapshot (still "new") arrives after the live update
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.locator('[data-testid="incident-row"][data-incident="INC-7f3a9c21b001"]').getAttribute("data-lifecycle"), "acknowledged");
  assert.equal(await page.getByTestId("pinned-section").count(), 0, "not pinned again by the stale snapshot");
  await mock.control("incidents_delay", { ms: 0 });
  await ctx.close();
  await other.ctx.close();
});

test("area filter follows the URL", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "manager");
  await page.goto(`${base}/incidents/?room=kitchen`);
  await page.getByTestId("incident-row").first().waitFor();
  assert.equal(await page.getByTestId("filter-room").inputValue(), "kitchen");
  await page.goto(`${base}/`);
  await page.getByTestId("room-tile").first().waitFor();
  // client-side navigation to another area's link updates the filter (no stale initial value)
  await page.evaluate(() => {
    window.history.pushState(null, "", "/incidents/?room=back");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.goto(`${base}/incidents/?room=kitchen`);
  await page.getByTestId("filter-lifecycle").selectOption("all");
  await page.locator('[data-incident="INC-91c0de55a003"]').waitFor();
  await page.goBack();
  await page.goForward();
  await page.getByTestId("filter-room").selectOption("back");
  await page.waitForURL(/room=back/);
  await page.locator('[data-testid="incident-row"][data-incident="INC-2b8e44d0c002"]').waitFor();
  assert.equal(await page.locator('[data-testid="incident-row"][data-incident="INC-91c0de55a003"]').count(), 0);
  // selecting a row keeps the filter
  await page.locator('[data-testid="incident-row"][data-incident="INC-2b8e44d0c002"] a').click();
  await page.waitForURL(/id=INC-2b8e44d0c002/);
  assert.match(page.url(), /room=back/);
  assert.equal(await page.getByTestId("filter-room").inputValue(), "back");
  await ctx.close();
});

test("search incidents by POS ticket (pos_ref) and see it on the detail", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.goto(`${base}/incidents/`);
  await page.getByTestId("incident-row").first().waitFor();
  const req = page.waitForRequest((r) => r.url().includes("/api/v1/incidents?") && r.url().includes("pos_ref=t-1042"));
  await page.getByTestId("pos-search-input").fill("t-1042");
  await page.getByTestId("pos-search-submit").click();
  await req;
  const results = page.getByTestId("pos-results");
  await results.getByTestId("incident-row").first().waitFor();
  assert.equal(await results.getByTestId("incident-row").count(), 1);
  assert.equal(await results.getByTestId("incident-row").getAttribute("data-incident"), "INC-7f3a9c21b001");
  await results.locator("a.inbox-link").click();
  await page.getByTestId("detail-pos-ref").waitFor();
  assert.match(await page.getByTestId("detail-pos-ref").innerText(), /T-1042/);
  assert.equal(await page.getByTestId("pos-ref").innerText(), "T-1042");
  await page.getByTestId("pos-search-input").fill("T-9999");
  await page.getByTestId("pos-search-submit").click();
  await results.getByText("No incidents for this ticket").waitFor();
  await page.getByTestId("pos-search-clear").click();
  await page.getByTestId("pos-results").waitFor({ state: "detached" });
  await ctx.close();
});

test("disposition flow: final, then disabled", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "manager");
  await page.goto(`${base}/incidents/?id=INC-91c0de55a003`);
  await page.getByTestId("not-a-finding").waitFor();
  assert.match(await page.getByTestId("not-a-finding").innerText(), /AI flags, humans decide.*not a finding about any person/);
  assert.match(await page.getByTestId("model-versions").innerText(), /detector/);
  const form = page.getByTestId("disposition-form");
  await form.getByLabel(/^OK/).check();
  await form.getByLabel("Note (optional)").fill("Checked the clip: delivery driver with a manager at the cooler.");
  await form.getByTestId("disposition-submit").click();
  await form.getByTestId("disposition-confirm").click();
  await page.locator('[data-testid="incident-detail"][data-lifecycle="resolved"]').waitFor();
  await form.getByTestId("disposition-final").waitFor();
  assert.ok(await form.locator('input[type="radio"]').first().isDisabled(), "radios disabled after resolve");
  assert.match(await page.getByTestId("timeline").innerText(), /Disposition recorded: OK/);
  const s = await mock.state();
  assert.equal(s.incidents.find((i) => i.id === "INC-91c0de55a003").disposition, "ok");
  await ctx.close();
});

test("disposition 409 when someone else resolved first", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "manager");
  await page.goto(`${base}/incidents/?id=INC-2b8e44d0c002`);
  const form = page.getByTestId("disposition-form");
  await form.getByLabel(/^Coach/).check();
  await mock.control("resolve", { id: "INC-2b8e44d0c002", disposition: "false_detection", actor: "other" });
  await form.getByTestId("disposition-submit").click();
  await form.getByTestId("disposition-confirm").click();
  await form.getByTestId("disposition-error").waitFor();
  assert.match(await form.getByTestId("disposition-error").innerText(), /Someone else resolved this incident first/);
  await form.getByTestId("disposition-final").waitFor();
  assert.match(await form.getByTestId("disposition-final").innerText(), /False detection/);
  assert.ok(await form.locator('input[type="radio"]').first().isDisabled(), "radios disabled after resolve");
  await ctx.close();
});

test("timeline is in chronological order (by time, not string)", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "owner");
  // millisecond precision sorts wrongly as text against second precision ("…00.5Z" > "…00Z" but "…01Z" > "…00.5Z")
  const s = await mock.state();
  const inc = s.incidents.find((i) => i.id === "INC-4d2f11e9b004");
  await mock.control("emit", {
    type: "incident_updated",
    data: { ...inc, actions: [...inc.actions, { actor: "olivia", action: "legal_hold_released", disposition: null, note: null, at: new Date(Date.parse(inc.start) + 500).toISOString() }] },
  });
  await page.goto(`${base}/incidents/?id=INC-4d2f11e9b004`);
  await page.getByTestId("timeline").waitFor();
  await mock.control("emit", {
    type: "incident_updated",
    data: { ...inc, actions: [...inc.actions, { actor: "olivia", action: "legal_hold_released", disposition: null, note: null, at: new Date(Date.parse(inc.start) + 500).toISOString() }] },
  });
  await page.getByTestId("timeline").getByText("Legal hold released").waitFor();
  const labels = await page.$$eval('[data-testid="timeline"] li strong', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels.slice(0, 3), ["Detection started", "Legal hold released", "Detection ended"]);
  await ctx.close();
});

test("legal hold: set directly, release only after confirmation (owner)", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "owner");
  await page.goto(`${base}/incidents/?id=INC-91c0de55a003`);
  const sw = page.getByTestId("legal-hold");
  await sw.waitFor();
  assert.equal(await sw.getAttribute("aria-checked"), "false");
  assert.equal(await sw.getAttribute("aria-label"), "Legal hold", "short accessible name");
  assert.equal(await sw.getAttribute("aria-describedby"), "hold-desc", "the deadline is the description");
  await sw.click();
  await page.locator('[data-testid="legal-hold"][aria-checked="true"]').waitFor();
  assert.equal((await mock.state()).incidents.find((i) => i.id === "INC-91c0de55a003").legal_hold, true);
  // releasing asks first; cancelling keeps the hold
  await sw.click();
  await page.getByTestId("hold-release-confirm").waitFor();
  assert.equal(await sw.getAttribute("aria-checked"), "true");
  await page.getByRole("button", { name: "Keep the hold" }).click();
  await page.getByTestId("hold-release-confirm").waitFor({ state: "detached" });
  assert.equal((await mock.state()).incidents.find((i) => i.id === "INC-91c0de55a003").legal_hold, true);
  await sw.click();
  await page.getByTestId("hold-release-yes").click();
  await page.locator('[data-testid="legal-hold"][aria-checked="false"]').waitFor();
  assert.equal((await mock.state()).incidents.find((i) => i.id === "INC-91c0de55a003").legal_hold, false);
  await ctx.close();
});

test("clip playback via token loads video metadata (manager); staff sees no clip", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "manager");
  await page.goto(`${base}/incidents/?id=INC-7f3a9c21b001`);
  await page.getByTestId("clip-logged").waitFor();
  assert.match(await page.getByTestId("clip-logged").innerText(), /Access to this clip is logged/);
  const mediaReqs = [];
  page.on("request", (r) => {
    if (r.url().includes("/media?token=")) mediaReqs.push(r.headers().range ?? "");
  });
  const tokenReq = page.waitForResponse((r) => r.url().includes("/api/v1/clips/") && r.url().endsWith("/token") && r.request().method() === "POST");
  await page.getByTestId("clip-request").click();
  assert.equal((await tokenReq).status(), 200);
  const video = page.getByTestId("clip-video");
  await video.waitFor();
  const src = await video.getAttribute("src");
  assert.match(src, /^\/api\/v1\/clips\/INC-7f3a9c21b001-cam-counter\/media\?token=[0-9a-f]+$/);
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="clip-video"]');
    return v && v.readyState >= 1 && v.duration > 0;
  }, null, { timeout: 8000 });
  const duration = await video.evaluate((v) => v.duration);
  assert.ok(duration > 2 && duration < 4, `fixture clip is ~3 s (got ${duration})`);
  assert.ok(!mediaReqs.includes("bytes=0-0"), "no diagnostic Range probe");
  const s = await mock.state();
  assert.equal(s.audit.filter((a) => a.action === "clip_viewed" && a.actor === "sam").length, 1, "one view audit-logged per token");
  await ctx.close();

  const c2 = await fresh();
  await login(c2.page, base, "staff");
  await c2.page.goto(`${base}/incidents/?id=INC-7f3a9c21b001`);
  await c2.page.getByTestId("clip-locked").waitFor();
  assert.equal(await c2.page.getByTestId("disposition-form").count(), 0);
  assert.equal(await c2.page.getByTestId("legal-hold").count(), 0);
  await c2.ctx.close();
});

test("shadow incidents: hidden by default, opt-in toggle only for view_shadow roles; no Acknowledge on detail", async () => {
  const c1 = await fresh();
  await login(c1.page, base, "staff");
  await c1.page.goto(`${base}/incidents/`);
  await c1.page.getByTestId("incident-row").first().waitFor();
  assert.equal(await c1.page.getByTestId("toggle-shadow").count(), 0);
  assert.equal(await c1.page.locator('[data-incident="INC-c05e7a8fd005"]').count(), 0);
  await c1.page.goto(`${base}/incidents/?id=INC-c05e7a8fd005`);
  await c1.page.getByText("Incident not found").waitFor();
  await c1.ctx.close();

  const { ctx, page } = await fresh();
  await login(page, base, "owner");
  await page.goto(`${base}/incidents/`);
  await page.getByTestId("incident-row").first().waitFor();
  assert.equal(await page.locator('[data-incident="INC-c05e7a8fd005"]').count(), 0, "not shown before opting in");
  const req = page.waitForRequest((r) => r.url().includes("/api/v1/incidents?") && r.url().includes("shadow=1"));
  await page.getByTestId("toggle-shadow").check();
  await req;
  const row = page.locator('[data-testid="incident-row"][data-incident="INC-c05e7a8fd005"]');
  await row.waitFor();
  assert.equal(await row.getByTestId("ack-button").count(), 0, "no Acknowledge in the inbox for SHADOW");
  await row.locator("a").click();
  await page.locator('[data-testid="incident-detail"][data-incident="INC-c05e7a8fd005"]').waitFor();
  await page.getByTestId("shadow-info").waitFor();
  assert.equal(await page.getByTestId("incident-detail").getByTestId("ack-button").count(), 0, "no Acknowledge on the SHADOW detail");
  await ctx.close();
});

test("clip deleted under retention (410) and audit failure (503)", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "owner");
  await page.goto(`${base}/incidents/?id=INC-e1aa0b77c006`);
  await page.getByTestId("clip-deleted").waitFor(); // deleted_at already set: no token requested
  await page.goto(`${base}/incidents/?id=INC-7f3a9c21b001`);
  await page.getByTestId("clip-request").waitFor();
  await mock.control("clip_delete", { id: "INC-7f3a9c21b001-cam-counter" });
  await page.getByTestId("clip-request").click();
  // media 410 -> the player re-reads the incident and shows the retention deletion
  await page.getByTestId("clip-deleted").waitFor();
  assert.match(await page.getByTestId("clip-deleted").innerText(), /deleted under the retention policy/);
  await mock.control("audit_fail", { on: true });
  await page.getByRole("button", { name: "cam-entrance" }).click();
  await page.getByTestId("clip-request").click();
  await page.getByText(/could not be recorded in the audit log/).waitFor();
  assert.equal((await mock.state()).audit.filter((a) => a.action === "clip_viewed" && a.actor === "olivia" && a.subject.includes("INC-7f3a9c21b001")).length, 0, "nothing served, nothing logged as viewed");
  await ctx.close();
});

test("new incident appears live via SSE, with alert toast", async () => {
  const { ctx, page, errors } = await fresh();
  await login(page, base, "staff");
  await page.goto(`${base}/incidents/`);
  await page.getByTestId("incident-row").first().waitFor();
  const sound = page.getByTestId("sound-toggle");
  assert.equal(await sound.getAttribute("aria-label"), "Alert sound");
  await sound.click(); // user gesture enables WebAudio chime
  await page.locator('[data-testid="sound-toggle"][aria-pressed="true"]').waitFor();
  assert.equal(await sound.getAttribute("aria-label"), "Alert sound", "the name does not change with the state");
  const inc = await mock.control("incident", { room_id: "dining", room_zone: "dining-floor", event_type: "person_down", cameras: ["cam-dining"] });
  await page.locator(`[data-testid="incident-row"][data-incident="${inc.id}"]`).waitFor({ timeout: 4000 });
  const toast = page.getByTestId("toast").filter({ hasText: "Dining room" });
  await toast.waitFor();
  assert.match(await toast.innerText(), /Possible person down/);
  assert.equal(await page.getByTestId("pinned-section").getByTestId("incident-row").count(), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("toast overflow keeps urgent sticky toasts; acknowledging clears its toast", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.getByTestId("room-tile").first().waitFor();
  const ids = [];
  for (const [room_id, room_zone, event_type] of [
    ["back", "back-door", "after_hours_intrusion"],
    ["counter", "register-1", "unattended_post"],
    ["dining", "dining-floor", "person_down"],
  ]) {
    ids.push((await mock.control("incident", { room_id, room_zone, event_type })).id);
  }
  const sticky = page.locator('[data-testid="toast"][data-sticky="true"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="toast"][data-sticky="true"]').length === 3);
  for (let i = 0; i < 8; i++) {
    await mock.control("emit", { type: "alert_delivery_failed", data: { incident_id: ids[0], channel: `sms-${i}`, error: "timeout" } });
  }
  await page.getByTestId("toast").filter({ hasText: "sms-7" }).waitFor();
  assert.equal(await sticky.count(), 3, "urgent sticky toasts are never evicted by later notifications");
  assert.ok((await page.locator('[data-testid="toast"][data-sticky="false"]').count()) <= 4, "non-sticky toasts are capped");
  assert.equal(await page.getByTestId("toast").filter({ hasText: "sms-0" }).count(), 0, "oldest non-sticky toast evicted");
  assert.equal(await pagePost(page, `/api/v1/incidents/${ids[1]}/ack`), 200);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="toast"][data-sticky="true"]').length === 2);
  await ctx.close();
});

test("session expiry (401) returns to login with a message", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "staff");
  await page.goto(`${base}/incidents/`);
  await page.getByTestId("incident-row").first().waitFor();
  await mock.control("sessions/expire");
  await page.waitForURL(/\/login\/\?/, { timeout: 10_000 });
  await page.getByTestId("session-expired").waitFor();
  assert.match(page.url(), /expired=1/);
  assert.match(decodeURIComponent(page.url()), /next=\/incidents\//);
  // signing in again returns to where the user was
  await page.getByLabel("Username").fill("jo");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/incidents\/$/);
  await ctx.close();
});

// ------------------------------------------------------------------ analytics

test("traffic: totals, busiest hour and an accessible day × hour heat map in site time", async () => {
  const { ctx, page, errors } = await fresh();
  await login(page, base, "manager");
  await page.getByTestId("nav-traffic").click();
  const map = page.getByTestId("heatmap");
  await map.waitFor();
  assert.match(await page.getByTestId("traffic-tz").innerText(), /America\/New_York/);
  assert.equal(await map.locator("caption").count(), 1, "table has a caption");
  assert.equal(await map.locator('tbody th[scope="row"]').count(), 7, "one row per weekday");
  const cells = await page.$$eval('[data-testid="heat-cell"]', (els) => els.map((e) => ({ v: Number(e.getAttribute("data-value")), text: e.textContent.trim(), cls: e.className })));
  assert.ok(cells.length >= 7 * 10, "hours with traffic are shown");
  for (const c of cells) assert.ok(c.text.startsWith(String(c.v)), "every cell prints its number (not colour alone)");
  assert.ok(cells.some((c) => /hm-4/.test(c.cls)) && cells.some((c) => /hm-0/.test(c.cls)), "uses the full ramp");
  const sum = cells.reduce((s, c) => s + c.v, 0);
  const visitors = Number((await page.getByTestId("stat-visitors").locator(".stat-value").innerText()).replace(/,/g, ""));
  assert.equal(sum, visitors, "visitors = sum of entries in the grid");
  assert.ok(visitors > 500);
  assert.match(await page.getByTestId("stat-busiest-slot").innerText(), /Sat 19:00/);
  assert.match(await page.getByTestId("stat-busiest-hour").innerText(), /19:00–20:00/);
  // per-camera filter: a camera without a count line has occupancy but no visitors
  await page.getByTestId("traffic-camera").selectOption("cam-dining");
  await page.getByTestId("stat-visitors").filter({ hasText: /^Visitors \(entries\)\s*0/ }).waitFor();
  assert.match(await page.getByTestId("traffic-tz").innerText(), /no count line/);
  assert.ok(Number(await page.getByTestId("stat-peak-occupancy").locator(".stat-value").innerText()) > 0);
  await page.getByTestId("traffic-camera").selectOption("cam-entrance");
  await page.getByTestId("stat-visitors").filter({ hasText: String(visitors.toLocaleString("en-US")) }).waitFor();
  const req = page.waitForRequest((r) => r.url().includes("/api/v1/analytics/traffic?from="));
  await page.getByTestId("traffic-range").selectOption("28");
  const u = new URL((await req).url());
  const days = (Date.parse(u.searchParams.get("to")) - Date.parse(u.searchParams.get("from"))) / 86_400_000;
  assert.ok(Math.abs(days - 28) < 0.01, `28-day range requested (${days})`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("access log: secure-zone visits, after-hours highlighted, date range filter", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "manager");
  await page.getByTestId("nav-access-log").click();
  await page.getByTestId("access-row").first().waitFor();
  const rows = await page.$$eval('[data-testid="access-row"]', (els) => els.map((e) => ({ after: e.getAttribute("data-after-hours"), cls: e.className, text: e.innerText })));
  assert.ok(rows.length >= 20);
  const after = rows.filter((r) => r.after === "true");
  assert.ok(after.length >= 2, "seeded after-hours visits are listed");
  for (const r of after) {
    assert.match(r.cls, /row-after-hours/, "after-hours rows are highlighted");
    assert.match(r.text, /After hours/, "and labelled in words");
  }
  assert.ok(rows.some((r) => /Person not recognised as staff/.test(r.text)));
  await page.getByTestId("access-after-only").check();
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="access-row"]').length === n, after.length);
  await page.getByTestId("access-after-only").uncheck();
  // one site-local day: 3 days ago holds the 02:10 back-door visit
  const day = siteDate(3);
  const req = page.waitForRequest((r) => r.url().includes("/api/v1/access-log?from="));
  await page.getByTestId("access-from").fill(day);
  await req;
  const req2 = page.waitForResponse((r) => r.url().includes("/api/v1/access-log?from=") && r.url().includes("to="));
  await page.getByTestId("access-to").fill(day);
  const list = await (await req2).json();
  const dayRows = page.getByTestId("access-row");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="access-row"]').length === n, list.length);
  assert.ok(list.length >= 4 && list.length <= 6, `one day of visits (${list.length})`);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const v of list) assert.equal(fmt.format(new Date(v.start)), day, "every visit is on the chosen site-local day");
  assert.ok(await dayRows.filter({ hasText: "Back door" }).filter({ hasText: "After hours" }).count() >= 1);
  await ctx.close();
});

// ------------------------------------------------------------------ admin

test("admin: camera registration requires authorization; zones JSON validated", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "admin");
  await page.getByTestId("nav-cameras").click();
  await page.getByTestId("camera-row").first().waitFor();
  const before = await page.getByTestId("camera-row").count();
  const form = page.getByTestId("camera-form");
  await form.getByLabel(/Camera ID/).fill("cam-reg2");
  await form.getByLabel(/Camera name/).fill("Register 2 overhead");
  await form.getByLabel(/Area ID/).fill("counter");
  await form.getByTestId("camera-submit").click();
  await form.getByText("Complete the required fields").waitFor();
  assert.ok((await form.getByText("Required").count()) >= 2);
  await form.getByTestId("zones-json").fill('[{"id":"z","room_zone":"r","kind":"post","polygon":[{"X":0,"Y":0},{"X":2,"Y":0}]}]');
  assert.match(await form.getByTestId("zones-status").innerText(), /at least 3 points/);
  await form.getByTestId("zones-json").fill('[{"id":"door","room_zone":"side-door","kind":"count_line","polygon":[{"X":0,"Y":0.5},{"X":0.5,"Y":0.5},{"X":1,"Y":0.5}]}]');
  assert.match(await form.getByTestId("zones-status").innerText(), /exactly 2 points/);
  await form.getByTestId("zones-json").fill('[{"id":"z","room_zone":"r","kind":"surface","polygon":[{"X":0,"Y":0},{"X":1,"Y":0},{"X":1,"Y":1}]}]');
  assert.match(await form.getByTestId("zones-status").innerText(), /"kind" must be one of restricted, secure/);
  await form.getByTestId("zones-json").fill("[{oops");
  assert.match(await form.getByTestId("zones-status").innerText(), /Not valid JSON/);
  await form.getByTestId("zones-json").fill(
    '[{"id":"reg2-staff","room_zone":"register-2","kind":"post","polygon":[{"X":0.1,"Y":0.1},{"X":0.5,"Y":0.1},{"X":0.5,"Y":0.5}]},{"id":"line","room_zone":"side-door","kind":"count_line","polygon":[{"X":0,"Y":0.8},{"X":1,"Y":0.8}]}]',
  );
  assert.match(await form.getByTestId("zones-status").innerText(), /2 zones valid/);
  await form.getByLabel(/Authorized by/).fill("Owner (O. Grant)");
  await form.getByLabel(/Authorization scope/).fill("Register 2 and its queue; video only");
  await form.getByTestId("camera-priority").check();
  await form.getByTestId("camera-submit").click();
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="camera-row"]').length === n + 1, before);
  const cam = (await mock.state()).cameras.find((c) => c.id === "cam-reg2");
  assert.equal(cam.authorized_by, "Owner (O. Grant)");
  assert.equal(cam.priority, true);
  assert.equal(cam.staff_only, false);
  assert.equal(cam.zones[1].kind, "count_line");
  await ctx.close();
});

test("admin: users list + create", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "admin");
  await page.goto(`${base}/users/`);
  await page.getByTestId("user-row").first().waitFor();
  const form = page.getByTestId("user-form");
  await form.getByLabel(/Username/).fill("newmgr");
  await form.getByLabel("Display name").fill("New Manager");
  await form.getByLabel(/^Manager/).check();
  await form.getByLabel(/Initial password/).fill("short");
  assert.match(await form.innerText(), /At least 12 characters/);
  await form.getByLabel(/Initial password/).fill("a-long-enough-password");
  await form.getByTestId("user-submit").click();
  await page.getByTestId("user-row").filter({ hasText: "newmgr" }).waitFor();
  assert.equal((await mock.state()).users.find((u) => u.username === "newmgr").role, "manager");
  await ctx.close();
});

test("admin: disable a user (with confirmation) ends their session; role change and password reset", async () => {
  const victim = await fresh();
  await login(victim.page, base, "staff");
  const { ctx, page } = await fresh();
  await login(page, base, "admin");
  await page.goto(`${base}/users/`);
  const row = page.locator('[data-testid="user-row"][data-username="jo"]');
  await row.waitFor();
  await row.getByTestId("user-manage").click();
  const edit = page.getByTestId("user-edit");
  await edit.waitFor();
  await edit.getByTestId("edit-disable").click();
  await edit.getByTestId("disable-confirm").waitFor();
  assert.equal((await mock.state()).users.find((u) => u.username === "jo").disabled, false, "nothing changes before confirming");
  await edit.getByTestId("disable-yes").click();
  await page.locator('[data-testid="user-row"][data-username="jo"][data-disabled="true"]').waitFor();
  assert.equal((await mock.state()).users.find((u) => u.username === "jo").disabled, true);
  // the disabled user's open dashboard is signed out
  await victim.page.waitForURL(/\/login\//, { timeout: 10_000 });
  await victim.ctx.close();
  // and cannot sign in
  const c3 = await fresh();
  await c3.page.goto(`${base}/login/`);
  await c3.page.getByLabel("Username").fill("jo");
  await c3.page.getByLabel("Password").fill(PASSWORD);
  await c3.page.getByRole("button", { name: "Sign in" }).click();
  await c3.page.getByTestId("login-error").waitFor();
  await c3.ctx.close();
  // enable again, then change role and reset password
  await edit.getByTestId("edit-enable").click();
  await page.locator('[data-testid="user-row"][data-username="jo"][data-disabled="false"]').waitFor();
  await edit.getByTestId("edit-role").selectOption("manager");
  await edit.getByTestId("edit-role-save").click();
  await edit.getByTestId("edit-ok").filter({ hasText: "Role changed to Manager" }).waitFor();
  await edit.getByTestId("edit-password").fill("another-long-password");
  await edit.getByTestId("edit-password-save").click();
  await edit.getByTestId("edit-ok").filter({ hasText: "Password reset" }).waitFor();
  const s = await mock.state();
  assert.equal(s.users.find((u) => u.username === "jo").role, "manager");
  assert.ok(s.audit.some((a) => a.action === "user_updated" && a.subject === "jo" && a.payload.password === "reset"));
  // an admin cannot disable or demote themselves
  await page.locator('[data-testid="user-row"][data-username="ada"]').getByTestId("user-manage").click();
  await page.getByTestId("user-edit").getByText("This is your own account").waitFor();
  assert.ok(await page.getByTestId("edit-disable").isDisabled());
  assert.ok(await page.getByTestId("edit-role").isDisabled());
  await ctx.close();
});

test("admin: audit chain status ok and broken", async () => {
  const { ctx, page } = await fresh();
  await login(page, base, "admin");
  await page.goto(`${base}/audit/`);
  await page.locator('[data-testid="chain-status"][data-ok="true"]').waitFor();
  assert.ok((await page.getByTestId("audit-row").count()) > 5);
  await mock.control("scenario", { name: "audit_broken" });
  await page.getByRole("button", { name: "Refresh" }).click();
  const broken = page.locator('[data-testid="chain-status"][data-ok="false"]');
  await broken.waitFor();
  assert.match(await broken.innerText(), /Audit chain broken at entry #7/);
  await ctx.close();
});

test("phone width: single column, bottom nav, alert-first", async () => {
  const { ctx, page } = await fresh({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await login(page, base, "staff");
  await page.getByTestId("attention-item").first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll (overflow ${overflow}px)`);
  assert.ok(await page.locator(".bottomnav").isVisible());
  assert.ok(!(await page.locator(".sidenav").isVisible()));
  const ackBox = await page.getByTestId("ack-button").first().boundingBox();
  assert.ok(ackBox.height >= 44, "ack touch target >= 44px");
  const attY = (await page.getByTestId("attention-item").first().boundingBox()).y;
  const tileY = (await page.getByTestId("room-tile").first().boundingBox()).y;
  assert.ok(attY < tileY, "alerts come before area tiles");
  await ctx.close();
});

// ------------------------------------------------------------------ runner

let pass = 0;
let fail = 0;
const t0 = Date.now();
for (const t of T) {
  if (only && !t.name.includes(only)) continue;
  await mock.control("reset");
  const s = Date.now();
  try {
    await t.fn();
    pass++;
    console.log(`  ✓ ${t.name} (${Date.now() - s} ms)`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${t.name}\n    ${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
await browser.close();
mock.stop();
process.exit(fail ? 1 : 0);
