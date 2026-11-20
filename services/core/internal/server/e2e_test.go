package server

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/harsha7123/ai_camera/services/core/internal/eventengine"
	"github.com/harsha7123/ai_camera/services/core/internal/store"
)

// NDJSON ingest -> engine -> incident -> SSE -> clip capture via the
// vision-worker API -> encrypted clip -> token -> Range playback -> expiry.
func TestEndToEnd(t *testing.T) {
	rules := eventengine.DefaultRules(map[string]eventengine.RuleOverride{
		// person_down keeps its default: alert policy, alerting not enabled,
		// so it produces SHADOW incidents.
		// long_queue is enabled (as an owner would after tuning) with a short
		// threshold, so the full alert path runs.
		"long_queue": {Policy: eventengine.PolicyAlert, AlertingEnabled: true, MaxPeople: 2, MinDurationS: 1},
	})
	// A long tick keeps wall-clock staleness out of this test; the overview
	// test covers it.
	e := newEnv(t, envOpts{rules: rules, cfg: Config{TickEvery: time.Hour, PingEvery: 100 * time.Millisecond}})
	staff, owner, mgr := e.client("staff"), e.client("owner"), e.client("manager")
	cs, rs := e.stream(staff), e.stream(owner)
	eventually(t, 2*time.Second, "subscribers", func() bool { return e.s.Hub.Subscribers() == 2 })

	// 1. A person lies on the dining-room floor for > 3 s: SHADOW.
	now := time.Now().UTC()
	var batch []eventengine.Observation
	for dt := -3300 * time.Millisecond; dt <= -100*time.Millisecond; dt += 200 * time.Millisecond {
		batch = append(batch, observation("cam-dining", now.Add(dt), lyingAt("p1", 0.4, 0.75)))
	}
	if st, out := e.ingest(testToken, batch...); st != http.StatusOK || out["accepted"] != float64(len(batch)) {
		t.Fatalf("ingest shadow batch: %d %v", st, out)
	}
	if ev := rs.next(t, 3*time.Second, "camera_state"); !strings.Contains(ev.Data, `"state":"FULLY_OPERATIONAL"`) {
		t.Fatalf("camera state %v", ev)
	}
	shadowEv := rs.next(t, 3*time.Second, "incident_created")
	var shadow store.IncidentView
	if err := json.Unmarshal([]byte(shadowEv.Data), &shadow); err != nil || shadow.Status != eventengine.StatusShadow || shadow.EventType != "person_down" {
		t.Fatalf("owner shadow incident: %v %s", err, shadowEv.Data)
	}

	// 2. Two customers wait in the counter queue for > 1 s: ALERTED.
	now = time.Now().UTC()
	batch = nil
	for dt := -1500 * time.Millisecond; dt <= -100*time.Millisecond; dt += 200 * time.Millisecond {
		batch = append(batch, observation("cam-counter", now.Add(dt), personAt("c1", 0.4, 0.85), personAt("c2", 0.6, 0.9)))
	}
	if st, out := e.ingest(testToken, batch...); st != http.StatusOK {
		t.Fatalf("ingest alert batch: %d %v", st, out)
	}

	// Staff's first incident event is the alerted one: the SHADOW incident
	// never reached them.
	created := cs.next(t, 3*time.Second, "incident_created", "incident_merged", "incident_updated")
	var alerted store.IncidentView
	if err := json.Unmarshal([]byte(created.Data), &alerted); err != nil {
		t.Fatal(err)
	}
	if created.Type != "incident_created" || alerted.Status != eventengine.StatusAlerted || alerted.EventType != "long_queue" || alerted.RoomID != "counter" ||
		alerted.Lifecycle != "new" || alerted.Source != eventengine.SourceMock || alerted.ID == shadow.ID {
		t.Fatalf("staff incident event: %s %s", created.Type, created.Data)
	}
	if ev := cs.next(t, 3*time.Second, "alert"); !strings.Contains(ev.Data, alerted.ID) || !strings.Contains(ev.Data, `"level":0`) {
		t.Fatalf("alert event %v", ev)
	}
	ready := cs.next(t, 5*time.Second, "clip_ready")
	var cr struct {
		IncidentID string `json:"incident_id"`
		ClipID     string `json:"clip_id"`
		Partial    bool   `json:"partial"`
	}
	if err := json.Unmarshal([]byte(ready.Data), &cr); err != nil || cr.IncidentID != alerted.ID || cr.ClipID != alerted.ID+"-cam-counter" {
		t.Fatalf("clip_ready %v", ready)
	}
	// The owner's SHADOW incident also gets a clip; staff must not hear of it.
	eventually(t, 5*time.Second, "shadow clip stored", func() bool {
		c, err := e.db.Clip(t.Context(), shadow.ID+"-cam-dining")
		return err == nil && c != nil
	})
	for _, ev := range cs.drain(300 * time.Millisecond) {
		if strings.Contains(ev.Data, shadow.ID) {
			t.Fatalf("SHADOW event leaked to staff: %v", ev)
		}
	}
	if cs.pings.Load() == 0 {
		t.Error("no keep-alive pings on the event stream")
	}

	// Detail includes the encrypted clip; the plaintext spool is gone.
	var detail store.IncidentDetail
	e.getJSON(mgr, "/api/v1/incidents/"+alerted.ID, &detail)
	if len(detail.Clips) != 1 || detail.Clips[0].SizeBytes == 0 || detail.Clips[0].SHA256 == "" {
		t.Fatalf("detail clips %+v", detail.Clips)
	}
	if entries, _ := filepathGlob(e.s.Cfg.ClipSpoolDir); len(entries) != 0 {
		t.Fatalf("plaintext left in spool: %v", entries)
	}

	// 3. Clip playback through a short-lived token.
	if st, _ := e.do(staff, "POST", "/api/v1/clips/"+cr.ClipID+"/token", "{}"); st != http.StatusForbidden {
		t.Fatalf("staff token: %d", st)
	}
	if st, _ := e.do(e.client("admin"), "POST", "/api/v1/clips/"+cr.ClipID+"/token", "{}"); st != http.StatusForbidden {
		t.Fatalf("admin token: %d (admins configure, they do not watch clips)", st)
	}
	if st, _ := e.do(mgr, "POST", "/api/v1/clips/"+shadow.ID+"-cam-dining/token", "{}"); st != http.StatusNotFound {
		t.Fatalf("manager token for SHADOW clip: %d, want 404", st)
	}
	st, b := e.do(mgr, "POST", "/api/v1/clips/"+cr.ClipID+"/token", "{}")
	var tok struct {
		URL       string    `json:"url"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(b, &tok); st != 200 || err != nil || !strings.HasPrefix(tok.URL, "/api/v1/clips/"+cr.ClipID+"/media?token=") {
		t.Fatalf("token: %d %s", st, b)
	}
	if d := time.Until(tok.ExpiresAt); d < 4*time.Minute || d > 5*time.Minute+time.Second {
		t.Fatalf("token lifetime %v", d)
	}
	want := strings.Repeat("clip-for-cam-counter;", 100)
	anon := e.client("") // the token alone authorizes playback (a <video> element)
	get := func(u, rng string) (*http.Response, string) {
		req, _ := http.NewRequest("GET", e.api.URL+u, nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		resp, err := anon.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp, string(body)
	}
	resp, body := get(tok.URL, "bytes=0-13")
	if resp.StatusCode != http.StatusPartialContent || body != want[:14] || resp.Header.Get("Content-Type") != "video/mp4" ||
		!strings.HasPrefix(resp.Header.Get("Content-Range"), "bytes 0-13/2100") {
		t.Fatalf("range: %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if resp, body = get(tok.URL, ""); resp.StatusCode != 200 || body != want {
		t.Fatalf("full: %d %d bytes", resp.StatusCode, len(body))
	}
	if resp, _ = get(strings.Replace(tok.URL, cr.ClipID, shadow.ID+"-cam-dining", 1), ""); !tokenRejected(resp.StatusCode) {
		t.Fatalf("token reused for another clip: %d", resp.StatusCode)
	}
	counts, _ := auditActions(t, e)
	if counts["clip_viewed"] != 1 || counts["incident_created"] != 2 || counts["clip_stored"] != 2 {
		t.Fatalf("audit %v", counts)
	}
	// Expired token.
	e.s.mu.Lock()
	for k, v := range e.s.clipTokens {
		v.expires = time.Now().Add(-time.Second)
		e.s.clipTokens[k] = v
	}
	e.s.mu.Unlock()
	if resp, _ = get(tok.URL, "bytes=0-1"); !tokenRejected(resp.StatusCode) {
		t.Fatalf("expired token: %d", resp.StatusCode)
	}

	// 4. Acknowledging stops the alert and reaches every client.
	if st, _ := e.do(staff, "POST", "/api/v1/incidents/"+alerted.ID+"/ack", "{}"); st != 200 {
		t.Fatalf("ack %d", st)
	}
	if ev := rs.next(t, 2*time.Second, "incident_updated"); !strings.Contains(ev.Data, `"acknowledged_by":"stan"`) {
		t.Fatalf("owner update %v", ev)
	}
	if n := e.visionN.Load(); n != 2 {
		t.Fatalf("vision-worker clip calls = %d, want 2 (one per incident and camera)", n)
	}
}

// tokenRejected: the contract says 403 for a bad or expired clip token; the
// server currently answers 401. Either refuses playback.
func tokenRejected(code int) bool {
	return code == http.StatusForbidden
}

func filepathGlob(dir string) ([]string, error) { return filepath.Glob(filepath.Join(dir, "*")) }

// After hours, anyone on camera is an intrusion. With alerting enabled for the
// rule it is ALERTED; the walk-in cooler visit is in the access log and the
// occupancy reaches the traffic counts.
func TestAfterHoursIntrusionThroughIngest(t *testing.T) {
	rules := eventengine.DefaultRules(map[string]eventengine.RuleOverride{
		"after_hours_intrusion": {Policy: eventengine.PolicyAlert, AlertingEnabled: true},
	})
	e := newEnv(t, envOpts{rules: rules, schedule: closedNowSchedule(t), cfg: Config{TickEvery: time.Hour}})
	stf := e.client("staff")
	sub := e.stream(stf)
	eventually(t, 2*time.Second, "subscriber", func() bool { return e.s.Hub.Subscribers() == 1 })

	var o overviewResp
	e.getJSON(stf, "/api/v1/overview", &o)
	if o.Business.Open || o.Business.Timezone != "UTC" || len(o.Business.Today) != 1 {
		t.Fatalf("business status %+v", o.Business)
	}

	now := time.Now().UTC()
	var batch []eventengine.Observation
	for dt := -5000 * time.Millisecond; dt <= -2500*time.Millisecond; dt += 250 * time.Millisecond {
		batch = append(batch, observation("cam-kitchen", now.Add(dt), personAt("k1", 0.85, 0.6)))
	}
	// The person has left: the visit ends and is logged.
	batch = append(batch, observation("cam-kitchen", now.Add(-100*time.Millisecond)))
	if st, out := e.ingest(testToken, batch...); st != http.StatusOK || out["accepted"] != float64(len(batch)) {
		t.Fatalf("ingest: %d %v", st, out)
	}
	ev := sub.next(t, 3*time.Second, "incident_created")
	var inc store.IncidentView
	if err := json.Unmarshal([]byte(ev.Data), &inc); err != nil || inc.EventType != "after_hours_intrusion" || inc.Family != "G" ||
		inc.Status != eventengine.StatusAlerted || inc.RoomID != "kitchen" {
		t.Fatalf("after-hours incident: %v %s", err, ev.Data)
	}
	if ev := sub.next(t, 3*time.Second, "alert"); !strings.Contains(ev.Data, inc.ID) {
		t.Fatalf("alert %v", ev)
	}

	mgr := e.client("manager")
	var log []store.ZoneAccessRow
	eventually(t, 3*time.Second, "access log entry", func() bool {
		log = nil
		e.getJSON(mgr, "/api/v1/access-log", &log)
		return len(log) == 1
	})
	// The kitchen camera is staff_only, so the visitor counts as staff; the
	// visit was still outside the staff window.
	if a := log[0]; a.CameraID != "cam-kitchen" || a.ZoneID != "cooler-door" || a.RoomZone != "walk-in-cooler" || a.Role != "staff" ||
		!a.AfterHours || !a.End.After(a.Start) {
		t.Fatalf("access log %+v", a)
	}
	var tr struct {
		Buckets []store.TrafficRow `json:"buckets"`
	}
	eventually(t, 3*time.Second, "traffic occupancy", func() bool {
		e.getJSON(mgr, "/api/v1/analytics/traffic", &tr)
		for _, b := range tr.Buckets {
			if b.CameraID == "cam-kitchen" && b.PeakOccupancy == 1 {
				return true
			}
		}
		return false
	})
}

// Evidence is captured once per incident and camera. A merge into an incident
// whose clip already exists (e.g. after a restart, when the in-memory pending
// set is empty) must not ask vision-worker again or overwrite the clip.
func TestClipNeverRecaptured(t *testing.T) {
	e := newEnv(t, envOpts{cfg: Config{TickEvery: time.Hour}})
	ctx := t.Context()
	inc := insertIncident(t, e, "recapture", eventengine.StatusReview)
	existing := store.ClipRecord{ID: inc + "-cam-dining", IncidentID: inc, CameraID: "cam-dining", Path: "/nonexistent.enc",
		SHA256: "original", SizeBytes: 1, WrappedKey: []byte("k"), Start: time.Now(), End: time.Now()}
	if err := e.db.InsertClip(ctx, existing); err != nil {
		t.Fatal(err)
	}
	pending := func() int {
		e.s.mu.RLock()
		defer e.s.mu.RUnlock()
		return len(e.s.clipPending)
	}
	e.s.handle(ctx, eventengine.Output{Kind: "incident_merged", CameraID: "cam-dining", Incident: &eventengine.Incident{ID: inc}})
	eventually(t, 3*time.Second, "capture decision", func() bool { return pending() == 0 })
	if n := e.visionN.Load(); n != 0 {
		t.Fatalf("vision-worker asked %d times for a clip that already exists", n)
	}
	c, err := e.db.Clip(ctx, existing.ID)
	if err != nil || c.SHA256 != "original" {
		t.Fatalf("existing clip changed: %+v %v", c, err)
	}

	// A second camera joining the incident still gets its own clip.
	e.s.handle(ctx, eventengine.Output{Kind: "incident_merged", CameraID: "cam-counter", Incident: &eventengine.Incident{ID: inc}})
	eventually(t, 5*time.Second, "second camera clip", func() bool {
		c, err := e.db.Clip(ctx, inc+"-cam-counter")
		return err == nil && c != nil
	})
	eventually(t, 3*time.Second, "capture finished", func() bool { return pending() == 0 })
	if n := e.visionN.Load(); n != 1 {
		t.Fatalf("vision-worker clip calls = %d, want 1", n)
	}
	// And handling it again does not capture again.
	e.s.handle(ctx, eventengine.Output{Kind: "incident_merged", CameraID: "cam-counter", Incident: &eventengine.Incident{ID: inc}})
	eventually(t, 3*time.Second, "capture decision", func() bool { return pending() == 0 })
	if n := e.visionN.Load(); n != 1 {
		t.Fatalf("vision-worker clip calls = %d after a repeat merge, want 1", n)
	}
}
