package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/harsha7123/ai_camera/services/core/internal/eventengine"
	"github.com/harsha7123/ai_camera/services/core/internal/store"
)

func insertIncident(t *testing.T, e *env, key string, status eventengine.IncidentStatus) string {
	t.Helper()
	return insertIncidentWith(t, e, key, status, nil)
}

// insertIncidentWith stores a restricted_zone_entry incident (the office door
// on the dining camera); mod may adjust it first.
func insertIncidentWith(t *testing.T, e *env, key string, status eventengine.IncidentStatus, mod func(*eventengine.Incident)) string {
	t.Helper()
	now := time.Now().UTC()
	in := &eventengine.Incident{ID: "INC-" + key, IdempotencyKey: key, RoomID: "dining",
		RoomZone: "office", EventType: "restricted_zone_entry", Family: "D", Start: now, End: now,
		Cameras: []string{"cam-dining"}, Status: status, RuleVersion: "d5-v0.1", Source: "MOCK", ModelVersions: map[string]string{}}
	if mod != nil {
		mod(in)
	}
	inc, _, err := e.db.InsertIfAbsent(in)
	if err != nil {
		t.Fatal(err)
	}
	return inc.ID
}

func auditActions(t *testing.T, e *env) (map[string]int, string) {
	t.Helper()
	var resp struct {
		Entries []store.AuditEntry `json:"entries"`
		ChainOK bool               `json:"chain_ok"`
	}
	e.getJSON(e.client("admin"), "/api/v1/audit?limit=1000", &resp)
	if !resp.ChainOK {
		t.Fatal("audit chain broken")
	}
	counts := map[string]int{}
	raw, _ := json.Marshal(resp.Entries)
	for _, en := range resp.Entries {
		counts[en.Action]++
	}
	return counts, string(raw)
}

func TestLoginLogoutAndAudit(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	anon := e.client("")
	if st, _ := e.do(anon, "POST", "/api/v1/login", `{"username":"stan","password":"wrong password!"}`); st != http.StatusUnauthorized {
		t.Fatalf("wrong password: %d", st)
	}
	if st, _ := e.do(anon, "POST", "/api/v1/login", `{"username":"ghost","password":"`+testPassword+`"}`); st != http.StatusUnauthorized {
		t.Fatalf("unknown user: %d", st)
	}

	req, _ := http.NewRequest("POST", e.api.URL+"/api/v1/login", strings.NewReader(`{"username":"olga","password":"`+testPassword+`"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var me meResp
	_ = json.NewDecoder(resp.Body).Decode(&me)
	resp.Body.Close()
	if resp.StatusCode != 200 || me.User.Username != "olga" || me.User.Role != "owner" || len(me.Permissions) != 8 {
		t.Fatalf("login: %d %+v", resp.StatusCode, me)
	}
	var ck *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "zeoatap_session" {
			ck = c
		}
	}
	if ck == nil || !ck.HttpOnly || ck.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie flags: %+v", ck)
	}

	c := e.client("staff")
	var got meResp
	e.getJSON(c, "/api/v1/me", &got)
	if got.User.Username != "stan" || strings.Join(permStrings(got), ",") != "view_status,acknowledge" {
		t.Fatalf("me: %+v", got)
	}
	if st, _ := e.do(c, "POST", "/api/v1/logout", ""); st != http.StatusNoContent {
		t.Fatalf("logout: %d", st)
	}
	if st, _ := e.do(c, "GET", "/api/v1/me", ""); st != http.StatusUnauthorized {
		t.Fatalf("me after logout: %d", st)
	}

	counts, raw := auditActions(t, e)
	if counts["login_failed"] != 2 || counts["login"] < 2 || counts["logout"] != 1 {
		t.Fatalf("audit counts %v", counts)
	}
	if strings.Contains(raw, "wrong password") || strings.Contains(raw, testPassword) {
		t.Fatal("passwords must never reach the audit log")
	}
}

func permStrings(m meResp) []string {
	var out []string
	for _, p := range m.Permissions {
		out = append(out, string(p))
	}
	return out
}

func TestRBACMatrix(t *testing.T) {
	e := newEnv(t, envOpts{})
	inc := insertIncident(t, e, "rbac", eventengine.StatusAlerted)
	type ep struct {
		method, path, body string
		allowed            []string // roles allowed; nil = any signed-in role
	}
	all := []string{"staff", "manager", "owner", "admin"}
	eps := []ep{
		{"GET", "/api/v1/me", "", all},
		{"GET", "/api/v1/overview", "", all},
		{"GET", "/api/v1/cameras", "", all},
		{"GET", "/api/v1/incidents", "", all},
		{"GET", "/api/v1/incidents/" + inc, "", all},
		{"GET", "/api/v1/events", "", all},
		{"POST", "/api/v1/incidents/INC-none/ack", "{}", all},
		{"POST", "/api/v1/incidents/INC-none/disposition", `{"disposition":"ok"}`, []string{"manager", "owner"}},
		{"POST", "/api/v1/incidents/INC-none/hold", `{"hold":true}`, []string{"owner", "admin"}},
		{"POST", "/api/v1/clips/none/token", "{}", []string{"manager", "owner"}},
		{"GET", "/api/v1/analytics/traffic", "", []string{"manager", "owner"}},
		{"GET", "/api/v1/access-log", "", []string{"manager", "owner"}},
		{"POST", "/api/v1/cameras", "{}", []string{"admin"}},
		{"GET", "/api/v1/users", "", []string{"admin"}},
		{"POST", "/api/v1/users", "{}", []string{"admin"}},
		{"POST", "/api/v1/users/999999", "{}", []string{"admin"}},
		{"GET", "/api/v1/audit", "", []string{"admin"}},
	}
	clients := map[string]*http.Client{"": e.client("")}
	for _, r := range all {
		clients[r] = e.client(r)
	}
	status := func(c *http.Client, x ep) int {
		if x.path == "/api/v1/events" {
			s := e.stream(c)
			defer s.cancel()
			return s.status
		}
		st, _ := e.do(c, x.method, x.path, x.body)
		return st
	}
	for _, x := range eps {
		if st := status(clients[""], x); st != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: %d, want 401", x.method, x.path, st)
		}
		for _, role := range all {
			allowed := false
			for _, a := range x.allowed {
				allowed = allowed || a == role
			}
			st := status(clients[role], x)
			if allowed && (st == http.StatusUnauthorized || st == http.StatusForbidden) {
				t.Errorf("%s %s as %s: %d, want allowed", x.method, x.path, role, st)
			}
			if !allowed && st != http.StatusForbidden {
				t.Errorf("%s %s as %s: %d, want 403", x.method, x.path, role, st)
			}
		}
	}
	// Clip media is token-only: a session cookie alone is not enough.
	if st, _ := e.do(clients["owner"], "GET", "/api/v1/clips/x/media", ""); !tokenRejected(st) {
		t.Errorf("media without token: %d", st)
	}
}

func TestPostRequiresJSON(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	inc := insertIncident(t, e, "ct", eventengine.StatusAlerted)
	c := e.client("staff")
	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"} {
		if st, _ := e.doType(c, "POST", "/api/v1/incidents/"+inc+"/ack", "{}", ct); st != http.StatusUnsupportedMediaType {
			t.Errorf("ack with Content-Type %q: %d, want 415", ct, st)
		}
		if st, _ := e.doType(e.client(""), "POST", "/api/v1/login", `{"username":"stan","password":"x"}`, ct); st != http.StatusUnsupportedMediaType {
			t.Errorf("login with Content-Type %q: %d, want 415", ct, st)
		}
	}
	if st, _ := e.doType(c, "POST", "/api/v1/incidents/"+inc+"/ack", "{}", "application/json; charset=utf-8"); st != http.StatusOK {
		t.Errorf("ack with JSON charset: %d", st)
	}
	var v store.IncidentDetail
	e.getJSON(c, "/api/v1/incidents/"+inc, &v)
	if v.Lifecycle != "acknowledged" {
		t.Fatalf("lifecycle %s", v.Lifecycle)
	}
}

func TestShadowHiddenFromStaff(t *testing.T) {
	e := newEnv(t, envOpts{})
	shadow := insertIncident(t, e, "shadow", eventengine.StatusShadow)
	visible := insertIncident(t, e, "review", eventengine.StatusReview)
	stf, own := e.client("staff"), e.client("owner")

	ids := func(c *http.Client, q string) map[string]bool {
		var list []store.IncidentView
		e.getJSON(c, "/api/v1/incidents"+q, &list)
		out := map[string]bool{}
		for _, i := range list {
			out[i.ID] = true
		}
		return out
	}
	for _, q := range []string{"", "?shadow=1", "?shadow=1&open=1"} {
		if got := ids(stf, q); got[shadow] || !got[visible] {
			t.Errorf("staff list %q = %v", q, got)
		}
	}
	if got := ids(own, ""); got[shadow] {
		t.Error("owner sees SHADOW only when asking for shadow=1")
	}
	if got := ids(own, "?shadow=1"); !got[shadow] || !got[visible] {
		t.Errorf("owner shadow=1 list = %v", got)
	}
	if st, _ := e.do(stf, "GET", "/api/v1/incidents/"+shadow, ""); st != http.StatusNotFound {
		t.Errorf("staff SHADOW detail: %d, want 404", st)
	}
	if st, _ := e.do(stf, "POST", "/api/v1/incidents/"+shadow+"/ack", "{}"); st != http.StatusNotFound {
		t.Errorf("staff SHADOW ack: %d, want 404", st)
	}
	if st, _ := e.do(own, "GET", "/api/v1/incidents/"+shadow, ""); st != http.StatusOK {
		t.Errorf("owner SHADOW detail: %d", st)
	}

	// Live events: the SHADOW incident reaches the owner only.
	cs, rs := e.stream(stf), e.stream(own)
	eventually(t, 2*time.Second, "both subscribed", func() bool { return e.s.Hub.Subscribers() == 2 })
	ctx := context.Background()
	for _, id := range []string{shadow, visible} {
		e.s.handle(ctx, eventengine.Output{Kind: "incident_created", Incident: &eventengine.Incident{ID: id}})
	}
	first := rs.next(t, 2*time.Second, "incident_created")
	if !strings.Contains(first.Data, shadow) {
		t.Fatalf("owner first event %v", first)
	}
	got := cs.next(t, 2*time.Second, "incident_created")
	if !strings.Contains(got.Data, visible) {
		t.Fatalf("staff got %v", got)
	}
	for _, ev := range cs.drain(200 * time.Millisecond) {
		if strings.Contains(ev.Data, shadow) {
			t.Fatalf("SHADOW event leaked to staff: %v", ev)
		}
	}
}

func TestAckDispositionHold(t *testing.T) {
	e := newEnv(t, envOpts{})
	inc := insertIncident(t, e, "flow", eventengine.StatusAlerted)
	stf, own := e.client("staff"), e.client("owner")
	sub := e.stream(stf)

	for i := 0; i < 2; i++ {
		st, b := e.do(stf, "POST", "/api/v1/incidents/"+inc+"/ack", "{}")
		var v store.IncidentDetail
		_ = json.Unmarshal(b, &v)
		if st != http.StatusOK || v.Lifecycle != "acknowledged" || *v.AcknowledgedBy != "stan" || len(v.Actions) != 1 {
			t.Fatalf("ack %d: %d %s", i, st, b)
		}
	}
	if ev := sub.next(t, 2*time.Second, "incident_updated"); !strings.Contains(ev.Data, `"lifecycle":"acknowledged"`) {
		t.Fatalf("update event %v", ev)
	}
	if st, _ := e.do(e.client("owner"), "POST", "/api/v1/incidents/INC-missing/ack", "{}"); st != http.StatusNotFound {
		t.Fatalf("ack missing: %d", st)
	}
	if st, _ := e.do(own, "POST", "/api/v1/incidents/"+inc+"/disposition", `{"disposition":"guilty"}`); st != http.StatusBadRequest {
		t.Fatalf("invalid disposition: %d", st)
	}
	st, b := e.do(own, "POST", "/api/v1/incidents/"+inc+"/disposition", `{"disposition":"coach","note":"talked with Dana about the office door"}`)
	if st != http.StatusOK || !strings.Contains(string(b), `"disposition":"coach"`) || !strings.Contains(string(b), `"lifecycle":"resolved"`) {
		t.Fatalf("disposition: %d %s", st, b)
	}
	if st, _ := e.do(own, "POST", "/api/v1/incidents/"+inc+"/disposition", `{"disposition":"ok"}`); st != http.StatusConflict {
		t.Fatalf("second disposition: %d, want 409", st)
	}
	if st, _ := e.do(own, "POST", "/api/v1/incidents/"+inc+"/hold", `{}`); st != http.StatusBadRequest {
		t.Fatalf("hold without value: %d", st)
	}
	st, b = e.do(e.client("admin"), "POST", "/api/v1/incidents/"+inc+"/hold", `{"hold":true}`)
	if st != http.StatusOK || !strings.Contains(string(b), `"legal_hold":true`) {
		t.Fatalf("hold: %d %s", st, b)
	}
	st, b = e.do(own, "POST", "/api/v1/incidents/"+inc+"/hold", `{"hold":false}`)
	if st != http.StatusOK || !strings.Contains(string(b), `"legal_hold":false`) {
		t.Fatalf("release: %d %s", st, b)
	}
	counts, raw := auditActions(t, e)
	if counts["incident_acknowledged"] != 1 || counts["incident_disposition"] != 1 || counts["legal_hold_set"] != 1 || counts["legal_hold_released"] != 1 {
		t.Fatalf("audit counts %v", counts)
	}
	if strings.Contains(raw, "Dana") {
		t.Fatal("disposition notes must not be copied into the audit log")
	}
}

func TestAdminCamerasAndUsers(t *testing.T) {
	e := newEnv(t, envOpts{})
	adm := e.client("admin")
	cam := `{"id":"cam-back","room_id":"back","name":"Back door and safe","staff_only":true,"zones":[{"id":"safe","room_zone":"safe","kind":"secure","polygon":[{"X":0.7,"Y":0.3},{"X":0.9,"Y":0.3},{"X":0.9,"Y":0.6}]}]`
	if st, b := e.do(adm, "POST", "/api/v1/cameras", cam+`}`); st != http.StatusBadRequest || !strings.Contains(string(b), "authorized_by") {
		t.Fatalf("camera without authorization: %d %s", st, b)
	}
	auth := `,"authorized_by":"Owner","authorized_at":"2026-10-02","authorization_scope":"Back door, dock and office safe"`
	st, b := e.do(adm, "POST", "/api/v1/cameras", cam+auth+`}`)
	var created store.Camera
	_ = json.Unmarshal(b, &created)
	if st != http.StatusCreated || !created.Enabled || created.State != "NOT_CONNECTED" || created.StateSince == nil ||
		!created.StaffOnly || created.Priority {
		t.Fatalf("create camera: %d %s", st, b)
	}
	if st, _ := e.do(adm, "POST", "/api/v1/cameras", cam+auth+`}`); st != http.StatusConflict {
		t.Fatalf("duplicate camera: %d", st)
	}
	if st, _ := e.do(adm, "POST", "/api/v1/cameras", strings.Replace(cam, "cam-back", "cam4", 1)+strings.Replace(auth, "2026-10-02", "yesterday", 1)+`}`); st != http.StatusBadRequest {
		t.Fatalf("bad date: %d", st)
	}
	if st, _ := e.do(adm, "POST", "/api/v1/cameras", strings.Replace(strings.Replace(cam, "cam-back", "cam5", 1), `"back"`, `"nope"`, 1)+auth+`}`); st != http.StatusBadRequest {
		t.Fatalf("unknown room: %d", st)
	}
	for _, bad := range []string{
		strings.Replace(cam, `"secure"`, `"surface"`, 1),    // infant-era zone kind
		strings.Replace(cam, `"secure"`, `"count_line"`, 1), // a count line needs exactly 2 points
	} {
		if st, b := e.do(adm, "POST", "/api/v1/cameras", strings.Replace(bad, "cam-back", "cam6", 1)+auth+`}`); st != http.StatusBadRequest {
			t.Fatalf("invalid zone: %d %s", st, b)
		}
	}
	var cams []store.Camera
	e.getJSON(e.client("staff"), "/api/v1/cameras", &cams)
	if len(cams) != 4 {
		t.Fatalf("cameras = %d", len(cams))
	}
	// The new camera is registered with the running engine.
	eventually(t, 2*time.Second, "cam-back known", func() bool { return e.s.knownCamera("cam-back") })

	st, b = e.do(adm, "POST", "/api/v1/users", `{"username":"newmgr","display_name":"New Manager","role":"manager","password":"long enough pw"}`)
	if st != http.StatusCreated || strings.Contains(string(b), "password") || !strings.Contains(string(b), `"role":"manager"`) {
		t.Fatalf("create user: %d %s", st, b)
	}
	for _, body := range []string{
		`{"username":"newmgr","display_name":"Dup","role":"manager","password":"long enough pw"}`,
	} {
		if st, _ := e.do(adm, "POST", "/api/v1/users", body); st != http.StatusConflict {
			t.Fatalf("duplicate user: %d", st)
		}
	}
	for _, body := range []string{
		`{"username":"x","display_name":"X","role":"manager","password":"short"}`,
		`{"username":"y","display_name":"Y","role":"caregiver","password":"long enough pw"}`,
		`{"username":"Bad Name","display_name":"Z","role":"manager","password":"long enough pw"}`,
		`{"username":"z","display_name":"","role":"manager","password":"long enough pw"}`,
	} {
		if st, _ := e.do(adm, "POST", "/api/v1/users", body); st != http.StatusBadRequest {
			t.Errorf("invalid user %s: %d", body, st)
		}
	}
	st, b = e.do(adm, "GET", "/api/v1/users", "")
	if st != 200 || !strings.Contains(string(b), "newmgr") || strings.Contains(string(b), "$2a$") {
		t.Fatalf("users: %d %s", st, b)
	}
	counts, raw := auditActions(t, e)
	if counts["camera_created"] != 1 || counts["user_created"] != 1 || strings.Contains(raw, "long enough pw") {
		t.Fatalf("audit %v", counts)
	}
}

func TestInternalIngest(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true, cfg: Config{IngestTimeout: 100 * time.Millisecond}})
	now := time.Now().UTC()
	ok := observation("cam-dining", now)
	if st, _ := e.ingest("", ok); st != http.StatusUnauthorized {
		t.Fatalf("no token: %d", st)
	}
	if st, _ := e.ingest("wrong-token", ok); st != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", st)
	}
	st, out := e.ingest(testToken, ok, observation("cam-unknown", now))
	if st != http.StatusOK || out["accepted"] != float64(1) || out["ignored"] != float64(1) {
		t.Fatalf("ingest: %d %v", st, out)
	}
	line, _ := json.Marshal(ok)
	bad := string(line) + "\n" + `{"camera_id":"cam-dining"}` + "\n" + string(line) + "\n"
	// The second line (0-based index 1) is bad; blank lines are not counted.
	bad = "\n" + bad
	if st, out := e.ingestRaw(testToken, bad); st != http.StatusBadRequest || out["accepted"] != float64(1) || out["line"] != float64(1) ||
		!strings.Contains(out["error"].(string), "line 1") {
		t.Fatalf("bad line: %d %v", st, out)
	}
	if st, _ := e.ingestRaw(testToken, `{"camera_id":"cam-dining","capture_ts":"2026-10-31T00:00:00Z","source":"x","extra":1}`); st != http.StatusBadRequest {
		t.Fatalf("unknown field: %d", st)
	}
	// With no engine draining the queue, a full backlog answers 503.
	e.s.obsCh = make(chan eventengine.Observation, 1)
	st, out = e.ingest(testToken, ok, ok, ok)
	if st != http.StatusServiceUnavailable || out["accepted"] != float64(1) {
		t.Fatalf("backlog: %d %v", st, out)
	}
}

func TestRetentionShredsExpiredKeepsHeld(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	ctx := context.Background()
	expired := insertIncident(t, e, "old", eventengine.StatusReview)
	held := insertIncident(t, e, "held", eventengine.StatusReview)
	fresh := insertIncident(t, e, "fresh", eventengine.StatusReview)
	paths := map[string]string{}
	for _, id := range []string{expired, held, fresh} {
		src := filepath.Join(t.TempDir(), "c.mp4")
		if err := os.WriteFile(src, []byte("video "+id), 0o600); err != nil {
			t.Fatal(err)
		}
		clipID := id + "-cam-dining"
		stored, err := e.s.Vault.Store(clipID, src)
		if err != nil {
			t.Fatal(err)
		}
		paths[clipID] = stored.Path
		if err := e.db.InsertClip(ctx, store.ClipRecord{ID: clipID, IncidentID: id, CameraID: "cam-dining", Path: stored.Path, SHA256: stored.SHA256,
			SizeBytes: stored.Size, WrappedKey: stored.WrappedKey, Start: time.Now(), End: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.db.Pool.Exec(ctx, `UPDATE incidents SET retention_deadline = now() - interval '1 hour' WHERE id = ANY($1)`, []string{expired, held}); err != nil {
		t.Fatal(err)
	}
	if err := e.db.SetLegalHold(ctx, held, "olga", true); err != nil {
		t.Fatal(err)
	}
	n, err := e.s.RunRetention(ctx)
	if err != nil || n != 1 {
		t.Fatalf("retention deleted %d (%v), want 1", n, err)
	}
	for clipID, path := range paths {
		c, err := e.db.Clip(ctx, clipID)
		if err != nil {
			t.Fatal(err)
		}
		_, statErr := os.Stat(path)
		gone := clipID == expired+"-cam-dining"
		if gone != (c.DeletedAt != nil) || gone != (c.WrappedKey == nil) || gone != os.IsNotExist(statErr) {
			t.Errorf("clip %s: deleted_at=%v key=%v file=%v", clipID, c.DeletedAt, c.WrappedKey != nil, statErr)
		}
		if _, err := e.s.Vault.Open(c.ID, path, c.WrappedKey, c.SHA256); gone == (err == nil) {
			t.Errorf("clip %s readable=%v after retention", clipID, err == nil)
		}
	}
	if n, _ := e.s.RunRetention(ctx); n != 0 {
		t.Fatalf("second run deleted %d", n)
	}
	if st, _ := e.do(e.client("owner"), "POST", "/api/v1/clips/"+expired+"-cam-dining/token", "{}"); st != http.StatusGone {
		t.Fatalf("token for shredded clip: %d, want 410", st)
	}
	counts, _ := auditActions(t, e)
	if counts["clip_deleted_retention"] != 1 {
		t.Fatalf("audit %v", counts)
	}
}

func TestWebStaticFallback(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"index.html": "<html>app</html>", "incidents.html": "<html>incidents</html>", "_next/app.js": "js"} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := newEnv(t, envOpts{noRun: true, cfg: Config{WebDir: dir}})
	c := e.client("")
	for path, want := range map[string]string{"/": "app", "/incidents": "incidents", "/rooms/kitchen": "app", "/_next/app.js": "js", "/../../etc/passwd": "app"} {
		st, b := e.do(c, "GET", path, "")
		if st != 200 || !strings.Contains(string(b), want) {
			t.Errorf("GET %s: %d %q, want %q", path, st, b, want)
		}
	}
	if st, _ := e.do(c, "GET", "/_next/missing.js", ""); st != http.StatusNotFound {
		t.Errorf("missing asset: %d", st)
	}
	if st, b := e.do(c, "GET", "/api/v1/nope", ""); st != http.StatusNotFound || !strings.Contains(string(b), `"error"`) {
		t.Errorf("unknown api path: %d %s", st, b)
	}
	if st, _ := e.do(c, "GET", "/healthz", ""); st != 200 {
		t.Errorf("healthz %d", st)
	}
}

func TestLoginThrottling(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	anon := e.client("")
	login := func(pw string) (int, http.Header) {
		req, _ := http.NewRequest("POST", e.api.URL+"/api/v1/login", strings.NewReader(`{"username":"stan","password":"`+pw+`"}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := anon.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode, resp.Header
	}
	for i := 0; i < 5; i++ {
		if st, _ := login("wrong password!"); st != http.StatusUnauthorized {
			t.Fatalf("failure %d: %d, want 401", i+1, st)
		}
	}
	for i := 0; i < 3; i++ {
		st, h := login("wrong password!")
		ra, err := strconv.Atoi(h.Get("Retry-After"))
		if st != http.StatusTooManyRequests || err != nil || ra < 1 || ra > 15*60+1 {
			t.Fatalf("locked attempt %d: %d Retry-After=%q", i, st, h.Get("Retry-After"))
		}
	}
	// While locked even the right password is refused.
	if st, h := login(testPassword); st != http.StatusTooManyRequests || h.Get("Retry-After") == "" {
		t.Fatalf("correct password while locked: %d", st)
	}
	// Other users are not affected by stan's lock.
	e.client("manager")

	counts, raw := auditActions(t, e)
	if counts["login_failed"] != 5 {
		t.Fatalf("login_failed audited %d times, want 5 (failures while locked are not audited)", counts["login_failed"])
	}
	if counts["login_locked"] != 1 {
		t.Fatalf("login_locked audited %d times, want 1", counts["login_locked"])
	}
	if strings.Contains(raw, "wrong password") || strings.Contains(raw, testPassword) {
		t.Fatal("passwords must never reach the audit log")
	}
}

func userID(t *testing.T, e *env, username string) int64 {
	t.Helper()
	var users []store.User
	e.getJSON(e.client("admin"), "/api/v1/users", &users)
	for _, u := range users {
		if u.Username == username {
			return u.ID
		}
	}
	t.Fatalf("no user %s", username)
	return 0
}

func TestUpdateUser(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	adm := e.client("admin")
	path := func(name string) string { return "/api/v1/users/" + strconv.FormatInt(userID(t, e, name), 10) }

	// A display-name change keeps the user signed in.
	mgr := e.client("manager")
	st, b := e.do(adm, "POST", path("mia"), `{"display_name":"Mia R."}`)
	if st != http.StatusOK || !strings.Contains(string(b), `"display_name":"Mia R."`) {
		t.Fatalf("rename: %d %s", st, b)
	}
	if st, _ := e.do(mgr, "GET", "/api/v1/me", ""); st != http.StatusOK {
		t.Fatalf("rename must not end sessions: %d", st)
	}

	// A role change ends the user's sessions.
	st, b = e.do(adm, "POST", path("mia"), `{"role":"staff"}`)
	if st != http.StatusOK || !strings.Contains(string(b), `"role":"staff"`) {
		t.Fatalf("role change: %d %s", st, b)
	}
	if st, _ := e.do(mgr, "GET", "/api/v1/me", ""); st != http.StatusUnauthorized {
		t.Fatalf("session after role change: %d, want 401", st)
	}
	var me meResp
	e.getJSON(e.client("manager"), "/api/v1/me", &me) // signs in as mia again
	if me.User.Role != "staff" || strings.Join(permStrings(me), ",") != "view_status,acknowledge" {
		t.Fatalf("after demotion: %+v", me)
	}

	// Disabling ends the sessions and blocks sign-in.
	stf := e.client("staff")
	if st, b := e.do(adm, "POST", path("stan"), `{"disabled":true}`); st != http.StatusOK || !strings.Contains(string(b), `"disabled":true`) {
		t.Fatalf("disable: %d %s", st, b)
	}
	if st, _ := e.do(stf, "GET", "/api/v1/me", ""); st != http.StatusUnauthorized {
		t.Fatalf("session after disable: %d, want 401", st)
	}
	if st, _ := e.do(e.client(""), "POST", "/api/v1/login", `{"username":"stan","password":"`+testPassword+`"}`); st != http.StatusUnauthorized {
		t.Fatalf("disabled login: %d", st)
	}

	// Password reset ends sessions; the new password works, the old does not.
	own := e.client("owner")
	if st, b := e.do(adm, "POST", path("olga"), `{"password":"a brand new passphrase"}`); st != http.StatusOK || strings.Contains(string(b), "passphrase") {
		t.Fatalf("password reset: %d %s", st, b)
	}
	if st, _ := e.do(own, "GET", "/api/v1/me", ""); st != http.StatusUnauthorized {
		t.Fatalf("session after password reset: %d, want 401", st)
	}
	if st, _ := e.do(e.client(""), "POST", "/api/v1/login", `{"username":"olga","password":"a brand new passphrase"}`); st != http.StatusOK {
		t.Fatalf("login with new password: %d", st)
	}
	if st, _ := e.do(adm, "POST", path("olga"), `{"password":"short"}`); st != http.StatusBadRequest {
		t.Fatalf("short password: %d", st)
	}

	// Admins cannot lock themselves out.
	self := path("adm")
	for _, body := range []string{`{"disabled":true}`, `{"role":"owner"}`, `{"role":"staff","display_name":"X"}`} {
		if st, _ := e.do(adm, "POST", self, body); st != http.StatusBadRequest {
			t.Errorf("self change %s: %d, want 400", body, st)
		}
	}
	if st, _ := e.do(adm, "GET", "/api/v1/me", ""); st != http.StatusOK {
		t.Fatalf("admin must still be signed in: %d", st)
	}
	var users []store.User
	e.getJSON(adm, "/api/v1/users", &users)
	for _, u := range users {
		if u.Username == "adm" && (u.Disabled || u.Role != "admin") {
			t.Fatalf("admin changed itself: %+v", u)
		}
	}
	for _, c := range []struct{ path, body string }{
		{"/api/v1/users/999999", `{"display_name":"Ghost"}`},
		{"/api/v1/users/abc", `{"display_name":"Ghost"}`},
	} {
		if st, _ := e.do(adm, "POST", c.path, c.body); st != http.StatusNotFound {
			t.Errorf("update %s: %d, want 404", c.path, st)
		}
	}
	for _, body := range []string{`{}`, `{"role":"caregiver"}`, `{"display_name":"  "}`} {
		if st, _ := e.do(adm, "POST", path("mia"), body); st != http.StatusBadRequest {
			t.Errorf("update with %s: %d, want 400", body, st)
		}
	}

	counts, raw := auditActions(t, e)
	if counts["user_updated"] != 4 {
		t.Fatalf("user_updated audited %d times, want 4: %v", counts["user_updated"], counts)
	}
	if !strings.Contains(raw, `"password_reset":true`) || strings.Contains(raw, "brand new passphrase") {
		t.Fatalf("password reset audit must record the reset but never the password: %s", raw)
	}
}

func TestAnalyticsAndAccessLog(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	ctx := context.Background()
	now := time.Now().UTC()
	bucket := now.Add(-2 * time.Hour).Truncate(eventengine.TrafficBucket)
	for _, d := range []eventengine.TrafficDelta{
		{CameraID: "cam-counter", Bucket: bucket, Entries: 3, PeakOccupancy: 2},
		{CameraID: "cam-counter", Bucket: bucket, Entries: 1, Exits: 2, PeakOccupancy: 5},
		{CameraID: "cam-counter", Bucket: bucket, PeakOccupancy: 4}, // a lower peak never lowers the bucket's
		{CameraID: "cam-counter", Bucket: now.Add(-30 * 24 * time.Hour).Truncate(eventengine.TrafficBucket), Entries: 9},
	} {
		if err := e.db.AddTraffic(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	visit := eventengine.ZoneAccess{CameraID: "cam-kitchen", RoomID: "kitchen", RoomZone: "walk-in-cooler", ZoneID: "cooler-door",
		Role: eventengine.RoleStaff, Start: now.Add(-time.Hour).Truncate(time.Microsecond), End: now.Add(-time.Hour + 40*time.Second).Truncate(time.Microsecond)}
	older := visit
	older.Role, older.AfterHours = eventengine.RolePerson, true
	older.Start, older.End = visit.Start.Add(-time.Hour), visit.End.Add(-time.Hour)
	for _, a := range []eventengine.ZoneAccess{visit, older, visit} { // the duplicate is ignored
		if err := e.db.InsertZoneAccess(ctx, a); err != nil {
			t.Fatal(err)
		}
	}

	for _, role := range []string{"staff", "admin"} {
		c := e.client(role)
		for _, p := range []string{"/api/v1/analytics/traffic", "/api/v1/access-log"} {
			if st, _ := e.do(c, "GET", p, ""); st != http.StatusForbidden {
				t.Errorf("%s %s: %d, want 403", role, p, st)
			}
		}
	}
	for _, role := range []string{"manager", "owner"} {
		c := e.client(role)
		var tr struct {
			Timezone      string             `json:"timezone"`
			BucketMinutes int                `json:"bucket_minutes"`
			Buckets       []store.TrafficRow `json:"buckets"`
		}
		e.getJSON(c, "/api/v1/analytics/traffic", &tr)
		if tr.BucketMinutes != 15 || tr.Timezone != "UTC" || len(tr.Buckets) != 1 {
			t.Fatalf("%s traffic: %+v", role, tr)
		}
		if b := tr.Buckets[0]; b.CameraID != "cam-counter" || !b.Start.Equal(bucket) || b.Entries != 4 || b.Exits != 2 || b.PeakOccupancy != 5 {
			t.Fatalf("%s traffic bucket: %+v", role, b)
		}
		// An explicit range that covers the older bucket.
		from := url.QueryEscape(now.Add(-40 * 24 * time.Hour).Format(time.RFC3339))
		e.getJSON(c, "/api/v1/analytics/traffic?from="+from, &tr)
		if len(tr.Buckets) != 2 {
			t.Fatalf("%s traffic over 40 days: %+v", role, tr.Buckets)
		}

		var log []store.ZoneAccessRow
		e.getJSON(c, "/api/v1/access-log", &log)
		if len(log) != 2 || log[0].ZoneID != "cooler-door" || log[0].Role != "staff" || log[0].AfterHours ||
			log[1].Role != "person" || !log[1].AfterHours || !log[0].Start.Equal(visit.Start) || log[0].RoomZone != "walk-in-cooler" {
			t.Fatalf("%s access log: %+v", role, log)
		}
		e.getJSON(c, "/api/v1/access-log?limit=1", &log)
		if len(log) != 1 || !log[0].Start.Equal(visit.Start) {
			t.Fatalf("%s access log limit=1: %+v", role, log)
		}
	}

	mgr := e.client("manager")
	ts := func(d time.Duration) string { return url.QueryEscape(now.Add(d).Format(time.RFC3339)) }
	for _, p := range []string{"/api/v1/analytics/traffic", "/api/v1/access-log"} {
		for _, q := range []string{
			"?from=" + ts(0) + "&to=" + ts(0),                 // from == to
			"?from=" + ts(time.Hour) + "&to=" + ts(0),         // from after to
			"?from=" + ts(-93*24*time.Hour) + "&to=" + ts(0),  // more than 92 days
			"?to=" + ts(0) + "&from=" + ts(-100*24*time.Hour), // more than 92 days
			"?from=yesterday",                                 // not RFC 3339
			"?to=2026-13-01T00:00:00Z",                        // not a time
		} {
			if st, b := e.do(mgr, "GET", p+q, ""); st != http.StatusBadRequest || !strings.Contains(string(b), `"error"`) {
				t.Errorf("GET %s%s: %d %s, want 400", p, q, st, b)
			}
		}
		if st, _ := e.do(mgr, "GET", p+"?from="+ts(-92*24*time.Hour)+"&to="+ts(0), ""); st != http.StatusOK {
			t.Errorf("GET %s over exactly 92 days: %d", p, st)
		}
	}
	for _, q := range []string{"0", "-1", "x"} {
		if st, _ := e.do(mgr, "GET", "/api/v1/access-log?limit="+q, ""); st != http.StatusBadRequest {
			t.Errorf("access-log limit=%s: %d", q, st)
		}
	}
}

func TestIncidentsFilterByPosRef(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	pos := func(ref string) func(*eventengine.Incident) {
		return func(i *eventengine.Incident) {
			i.RoomID, i.RoomZone, i.EventType, i.Family, i.Cameras = "counter", "register-1", "pos_no_sale", "C", []string{"cam-counter"}
			i.Source, i.PosRef = eventengine.SourcePOS, ref
		}
	}
	t1 := insertIncidentWith(t, e, "pos-t1", eventengine.StatusReview, pos("T-1"))
	insertIncidentWith(t, e, "pos-t10", eventengine.StatusReview, pos("T-10"))
	insertIncident(t, e, "no-pos", eventengine.StatusReview)
	shadowT1 := insertIncidentWith(t, e, "pos-t1-shadow", eventengine.StatusShadow, pos("T-1"))

	list := func(c *http.Client, q string) []store.IncidentView {
		var out []store.IncidentView
		e.getJSON(c, "/api/v1/incidents"+q, &out)
		return out
	}
	mgr := e.client("manager")
	if got := list(mgr, "?pos_ref=T-1"); len(got) != 1 || got[0].ID != t1 || got[0].PosRef != "T-1" {
		t.Fatalf("pos_ref=T-1: %+v", got)
	}
	if got := list(mgr, "?pos_ref=T-404"); len(got) != 0 {
		t.Fatalf("pos_ref=T-404: %+v", got)
	}
	if got := list(mgr, ""); len(got) != 3 {
		t.Fatalf("no filter: %d incidents, want 3", len(got))
	}
	// The SHADOW rule still applies under the filter.
	if got := list(mgr, "?pos_ref=T-1&shadow=1"); len(got) != 1 {
		t.Fatalf("manager pos_ref with shadow=1: %+v", got)
	}
	if got := list(e.client("owner"), "?pos_ref=T-1&shadow=1"); len(got) != 2 || (got[0].ID != shadowT1 && got[1].ID != shadowT1) {
		t.Fatalf("owner pos_ref with shadow=1: %+v", got)
	}
	if st, _ := e.do(mgr, "GET", "/api/v1/incidents?pos_ref="+strings.Repeat("x", 101), ""); st != http.StatusBadRequest {
		t.Fatalf("long pos_ref: %d", st)
	}
}

func TestPOSIngest(t *testing.T) {
	e := newEnv(t, envOpts{cfg: Config{TickEvery: time.Hour}})
	ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)
	noSale := `{"id":"toast-1","register_id":"reg1","type":"no_sale","ts":"` + ts + `","ticket_ref":"T-1","employee_ref":"E-17"}`

	if st, _ := e.postPOS("", noSale); st != http.StatusUnauthorized {
		t.Fatalf("no token: %d", st)
	}
	if st, _ := e.postPOS("wrong-token", noSale); st != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", st)
	}
	unknown := `{"id":"toast-2","register_id":"reg9","type":"no_sale","ts":"` + ts + `"}`
	sale := `{"id":"toast-3","register_id":"reg1","type":"sale","ts":"` + ts + `","amount_cents":1250,"ticket_ref":"T-2"}`
	st, out := e.postPOS(testToken, noSale+"\n\n"+unknown+"\n"+sale+"\n")
	if st != http.StatusOK || out["accepted"] != float64(2) || out["ignored"] != float64(1) {
		t.Fatalf("pos ingest: %d %v", st, out)
	}
	// A resend of the same id is ignored (deduplicated by id).
	if st, out := e.postPOS(testToken, noSale+"\n"); st != http.StatusOK || out["accepted"] != float64(0) || out["ignored"] != float64(1) {
		t.Fatalf("duplicate: %d %v", st, out)
	}

	mgr := e.client("manager")
	var list []store.IncidentView
	eventually(t, 3*time.Second, "pos_no_sale incident", func() bool {
		list = nil
		e.getJSON(mgr, "/api/v1/incidents?pos_ref=T-1", &list)
		return len(list) == 1
	})
	inc := list[0]
	if inc.EventType != "pos_no_sale" || inc.Family != "C" || inc.Status != eventengine.StatusReview || inc.Source != eventengine.SourcePOS ||
		inc.RoomID != "counter" || inc.RoomZone != "register-1" || len(inc.Cameras) != 1 || inc.Cameras[0] != "cam-counter" ||
		!strings.Contains(inc.Detail, "E-17") {
		t.Fatalf("no-sale incident: %+v", inc)
	}
	var all []store.IncidentView
	e.getJSON(e.client("owner"), "/api/v1/incidents?shadow=1", &all)
	if len(all) != 1 {
		t.Fatalf("a duplicate or a sale must not create incidents: %+v", all)
	}
	var n int
	if err := e.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pos_events`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("stored pos events = %d (%v), want 2", n, err)
	}

	// Malformed lines: the response names the 0-based line and what was accepted before it.
	good := func(id string) string {
		return `{"id":"` + id + `","register_id":"reg1","type":"sale","ts":"` + ts + `"}`
	}
	for _, c := range []struct {
		name, body string
		accepted   float64
	}{
		{"bad json", good("g1") + "\n{nope\n" + good("g2"), 1},
		{"unknown type", good("g3") + "\n" + good("g4") + "\n" + `{"id":"b1","register_id":"reg1","type":"chargeback","ts":"` + ts + `"}`, 2},
		{"missing ts", `{"id":"b2","register_id":"reg1","type":"refund"}`, 0},
		{"card data field", `{"id":"b3","register_id":"reg1","type":"sale","ts":"` + ts + `","card_number":"4111"}`, 0},
	} {
		st, out := e.postPOS(testToken, c.body)
		if st != http.StatusBadRequest || out["accepted"] != c.accepted || out["line"] != c.accepted || out["error"] == nil {
			t.Errorf("%s: %d %v, want 400 at line %v", c.name, st, out, c.accepted)
		}
	}
}

// When the engine queue is full, a POS event that was stored but not queued
// is removed again, so the connector's resend is processed, not ignored.
func TestPOSBacklogKeepsEventRetryable(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true, cfg: Config{IngestTimeout: 50 * time.Millisecond}})
	e.s.posCh = make(chan eventengine.POSEvent, 1)
	ts := time.Now().UTC().Format(time.RFC3339)
	ev := func(id string) string {
		return `{"id":"` + id + `","register_id":"reg1","type":"no_sale","ts":"` + ts + `"}` + "\n"
	}
	st, out := e.postPOS(testToken, ev("p1")+ev("p2")+ev("p3"))
	if st != http.StatusServiceUnavailable || out["accepted"] != float64(1) || out["line"] != float64(1) {
		t.Fatalf("backlog: %d %v", st, out)
	}
	<-e.s.posCh // the engine catches up
	st, out = e.postPOS(testToken, ev("p2"))
	if st != http.StatusOK || out["accepted"] != float64(1) || out["ignored"] != float64(0) {
		t.Fatalf("resend after backlog: %d %v, want accepted", st, out)
	}
}

func TestSecurityHeaders(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>app</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, envOpts{noRun: true, cfg: Config{WebDir: dir}})
	for _, p := range []string{"/api/v1/me", "/api/v1/overview", "/", "/incidents", "/healthz"} {
		resp, err := http.Get(e.api.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		csp := resp.Header.Get("Content-Security-Policy")
		if !strings.Contains(csp, "default-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") || !strings.Contains(csp, "object-src 'none'") {
			t.Errorf("GET %s: Content-Security-Policy %q", p, csp)
		}
		if resp.Header.Get("X-Frame-Options") != "DENY" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("GET %s: framing/sniffing headers %v", p, resp.Header)
		}
		if strings.HasPrefix(p, "/api/") && resp.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("GET %s: Cache-Control %q", p, resp.Header.Get("Cache-Control"))
		}
	}
}

func TestLegalHoldMissingIncident(t *testing.T) {
	e := newEnv(t, envOpts{noRun: true})
	for _, role := range []string{"owner", "admin"} {
		if st, b := e.do(e.client(role), "POST", "/api/v1/incidents/INC-missing/hold", `{"hold":true}`); st != http.StatusNotFound {
			t.Fatalf("%s hold on missing incident: %d %s", role, st, b)
		}
	}
	counts, _ := auditActions(t, e)
	if counts["legal_hold_set"] != 0 {
		t.Fatalf("a hold on a missing incident must not be audited as set: %v", counts)
	}
}
