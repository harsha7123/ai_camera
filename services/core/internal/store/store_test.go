package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/harsha7123/ai_camera/services/core/internal/eventengine"
	"github.com/harsha7123/ai_camera/services/core/internal/store"
	"github.com/harsha7123/ai_camera/services/core/internal/testutil/pgtest"
)

var ctx = context.Background()

func seedSite(t *testing.T, db *store.DB) {
	t.Helper()
	if err := db.UpsertFacility(ctx, "harbor-grill", "Harbor Grill"); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoom(ctx, "harbor-grill", store.Room{ID: "dining", Name: "Dining room"}); err != nil {
		t.Fatal(err)
	}
}

func incident(key string, status eventengine.IncidentStatus, start time.Time) *eventengine.Incident {
	return &eventengine.Incident{ID: "INC-" + key, IdempotencyKey: key, RoomID: "dining", RoomZone: "office",
		EventType: "restricted_zone_entry", Family: "D", Start: start, End: start.Add(time.Second), Cameras: []string{"cam-dining"},
		Status: status, RuleVersion: "d5-v0.1", ModelVersions: map[string]string{"detector": "mock-0"}, Source: "MOCK"}
}

func TestMigrationsIdempotent(t *testing.T) {
	db, _ := pgtest.New(t)
	for i := 0; i < 2; i++ {
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("migrate run %d: %v", i+2, err)
		}
	}
	var n int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("schema_migrations rows = %d, want 1", n)
	}
}

func TestInsertIdempotentAndMerge(t *testing.T) {
	db, _ := pgtest.New(t)
	t0 := time.Now().UTC().Truncate(time.Millisecond)
	inc := incident("k1", eventengine.StatusShadow, t0)
	got, created, err := db.InsertIfAbsent(inc)
	if err != nil || !created || got.ID != "INC-k1" {
		t.Fatalf("first insert: %v %v %v", got, created, err)
	}
	dup := incident("k1", eventengine.StatusShadow, t0)
	dup.ID = "INC-other"
	got, created, err = db.InsertIfAbsent(dup)
	if err != nil || created || got.ID != "INC-k1" {
		t.Fatalf("second insert must return the stored incident: %v %v %v", got, created, err)
	}

	m, err := db.FindMergeable("dining", "office", "restricted_zone_entry", t0.Add(5*time.Second), 10*time.Second)
	if err != nil || m == nil || m.ID != "INC-k1" {
		t.Fatalf("FindMergeable = %v, %v", m, err)
	}
	if m, _ := db.FindMergeable("dining", "office", "restricted_zone_entry", t0.Add(time.Minute), 10*time.Second); m != nil {
		t.Fatalf("incident outside the gap must not merge: %v", m.ID)
	}
	// Merging matches on event type, not family: another family-D event in
	// the same zone is a different incident.
	if m, _ := db.FindMergeable("dining", "office", "D", t0.Add(5*time.Second), 10*time.Second); m != nil {
		t.Fatalf("family must not match as an event type: %v", m.ID)
	}
	if m, _ := db.FindMergeable("dining", "office", "after_hours_intrusion", t0.Add(5*time.Second), 10*time.Second); m != nil {
		t.Fatalf("another event type must not merge: %v", m.ID)
	}
	m.Cameras = []string{"cam-dining", "cam-office"}
	m.End = t0.Add(4 * time.Second)
	m.Status = eventengine.StatusAlerted
	if err := db.Update(m); err != nil {
		t.Fatal(err)
	}
	back, err := db.Get("INC-k1")
	if err != nil || len(back.Cameras) != 2 || back.Status != eventengine.StatusAlerted || !back.End.Equal(m.End) {
		t.Fatalf("after update: %+v %v", back, err)
	}
	if g, err := db.Get("nope"); g != nil || err != nil {
		t.Fatalf("Get missing = %v %v", g, err)
	}
}

// Two cameras seeing the same room zone produce one incident through the
// real Postgres store.
func TestEngineMergesAcrossCamerasInPostgres(t *testing.T) {
	db, _ := pgtest.New(t)
	rect := func(x1, y1, x2, y2 float64) []eventengine.Point {
		return []eventengine.Point{{X: x1, Y: y1}, {X: x2, Y: y1}, {X: x2, Y: y2}, {X: x1, Y: y2}}
	}
	cams := []eventengine.Camera{
		{ID: "cam-dining", RoomID: "dining", Zones: []eventengine.Zone{{ID: "office-door", RoomZone: "office", Kind: eventengine.ZoneRestricted, Polygon: rect(0.8, 0.5, 1, 1)}}},
		{ID: "cam-hall", RoomID: "dining", Zones: []eventengine.Zone{{ID: "office-door-b", RoomZone: "office", Kind: eventengine.ZoneRestricted, Polygon: rect(0, 0.4, 0.3, 1)}}},
	}
	e := eventengine.New(cams, eventengine.DefaultRules(nil), db)
	t0 := time.Date(2026, 10, 31, 9, 0, 0, 0, time.UTC)
	person := func(x float64) eventengine.Track {
		return eventengine.Track{ID: "a", Role: eventengine.RolePerson, Score: 0.9, Box: [4]float64{x - 0.05, 0.5, x + 0.05, 0.8}, Visibility: 1}
	}
	for i := 0; i <= 30; i++ {
		ts := t0.Add(time.Duration(i) * 100 * time.Millisecond)
		for _, o := range []eventengine.Observation{
			{CameraID: "cam-dining", CaptureTS: ts, Source: "MOCK", AIAvailable: true, FrameSize: [2]int{1920, 1080}, Tracks: []eventengine.Track{person(0.9)}},
			{CameraID: "cam-hall", CaptureTS: ts, Source: "MOCK", AIAvailable: true, FrameSize: [2]int{1920, 1080}, Tracks: []eventengine.Track{person(0.15)}},
		} {
			if _, err := e.Process(o); err != nil {
				t.Fatal(err)
			}
		}
	}
	list, err := db.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || len(list[0].Cameras) != 2 || list[0].Status != eventengine.StatusReview || list[0].EventType != "restricted_zone_entry" {
		t.Fatalf("want one merged REVIEW_QUEUED incident from both cameras, got %+v", list)
	}
}

func TestAcknowledgeIdempotentAndResolveOnce(t *testing.T) {
	db, _ := pgtest.New(t)
	if _, _, err := db.InsertIfAbsent(incident("k2", eventengine.StatusAlerted, time.Now())); err != nil {
		t.Fatal(err)
	}
	changed, err := db.Acknowledge(ctx, "INC-k2", "jane")
	if err != nil || !changed {
		t.Fatalf("first ack: %v %v", changed, err)
	}
	changed, err = db.Acknowledge(ctx, "INC-k2", "bob")
	if err != nil || changed {
		t.Fatalf("second ack must be a no-op: %v %v", changed, err)
	}
	if _, err := db.Acknowledge(ctx, "INC-missing", "jane"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ack missing: %v", err)
	}
	if err := db.Resolve(ctx, "INC-k2", "mia", "coach", "checked"); err != nil {
		t.Fatal(err)
	}
	if err := db.Resolve(ctx, "INC-k2", "mia", "ok", ""); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("second disposition: %v, want ErrConflict", err)
	}
	inc, err := db.Incident(ctx, "INC-k2")
	if err != nil {
		t.Fatal(err)
	}
	if *inc.AcknowledgedBy != "jane" || *inc.Disposition != "coach" || inc.Lifecycle != "resolved" || len(inc.Actions) != 2 {
		t.Fatalf("unexpected incident state: %+v actions=%+v", inc.IncidentView, inc.Actions)
	}
}

func TestAuditChainDetectsTampering(t *testing.T) {
	db, _ := pgtest.New(t)
	for i, a := range []string{"login", "incident_acknowledged", "clip_viewed"} {
		if err := db.Audit(ctx, "jane", a, "INC-1", map[string]any{"n": i, "html": "<b>&</b>", "nested": map[string]any{"z": 1, "a": []int{1, 2}}}); err != nil {
			t.Fatal(err)
		}
	}
	if broken, err := db.VerifyAudit(ctx); err != nil || broken != 0 {
		t.Fatalf("intact chain: broken=%d err=%v", broken, err)
	}
	// The append-only triggers block edits, deletes and TRUNCATE.
	for _, stmt := range []string{`UPDATE audit_log SET actor='mallory' WHERE seq=2`, `DELETE FROM audit_log WHERE seq=2`, `TRUNCATE audit_log`} {
		if _, err := db.Pool.Exec(ctx, stmt); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("%s must be refused by the trigger: %v", stmt, err)
		}
	}
	var n int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&n); err != nil || n != 3 {
		t.Fatalf("audit rows after refused changes = %d (%v), want 3", n, err)
	}
	// An owner who disables the trigger can edit rows, but the chain shows it.
	err := pgx.BeginFunc(ctx, db.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE audit_log SET payload='{"n": 99}' WHERE seq=2`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if broken, err := db.VerifyAudit(ctx); err != nil || broken != 2 {
		t.Fatalf("tampered chain: broken=%d err=%v, want 2", broken, err)
	}
}

func TestAuditChainDetectsDeletion(t *testing.T) {
	db, _ := pgtest.New(t)
	for i := 0; i < 3; i++ {
		if err := db.Audit(ctx, "system", "x", "s", nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change;
		DELETE FROM audit_log WHERE seq=2; ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change`); err != nil {
		t.Fatal(err)
	}
	if broken, _ := db.VerifyAudit(ctx); broken != 3 {
		t.Fatalf("deletion: broken=%d, want 3", broken)
	}
}

func TestCameraInsertAndSessions(t *testing.T) {
	db, _ := pgtest.New(t)
	seedSite(t, db)
	c := store.Camera{ID: "cam-dining", RoomID: "dining", Name: "Dining room", AuthorizedBy: "Owner", AuthorizedAt: "2026-10-01",
		AuthorizationScope: "Dining room floor", Priority: true, StaffOnly: true, Enabled: true, Zones: []eventengine.Zone{}}
	if err := db.InsertCamera(ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertCamera(ctx, c); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate camera: %v", err)
	}
	if cams, err := db.Cameras(ctx); err != nil || len(cams) != 1 || !cams[0].Priority || !cams[0].StaffOnly || cams[0].AuthorizedAt != "2026-10-01" {
		t.Fatalf("cameras round trip: %+v %v", cams, err)
	}
	c.ID, c.RoomID = "cam2", "nope"
	if err := db.InsertCamera(ctx, c); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown room: %v", err)
	}
	c.ID, c.RoomID, c.AuthorizedBy = "cam3", "dining", ""
	if err := db.InsertCamera(ctx, c); err == nil {
		t.Fatal("camera without authorization must be refused by the schema")
	}

	id, err := db.CreateUser(ctx, store.User{Username: "jane", DisplayName: "Jane", Role: "staff", PasswordHash: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateUser(ctx, store.User{Username: "jane", DisplayName: "J", Role: "manager", PasswordHash: "x"}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate user: %v", err)
	}
	if err := db.CreateSession(ctx, "h1", id, time.Minute); err != nil {
		t.Fatal(err)
	}
	if u, err := db.SessionUser(ctx, "h1", time.Minute); err != nil || u.Username != "jane" {
		t.Fatalf("session user: %v %v", u, err)
	}
	if err := db.CreateSession(ctx, "h2", id, -time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SessionUser(ctx, "h2", time.Minute); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired session: %v", err)
	}
}

func TestRolesAndDispositionsEnforcedBySchema(t *testing.T) {
	db, _ := pgtest.New(t)
	for _, role := range []string{"caregiver", "lead", "reviewer", ""} {
		if _, err := db.CreateUser(ctx, store.User{Username: "u-" + role, DisplayName: "U", Role: role, PasswordHash: "x"}); err == nil {
			t.Errorf("role %q must be refused", role)
		}
	}
	for _, role := range []string{"staff", "manager", "owner", "admin"} {
		if _, err := db.CreateUser(ctx, store.User{Username: "u-" + role, DisplayName: "U", Role: role, PasswordHash: "x"}); err != nil {
			t.Errorf("role %q: %v", role, err)
		}
	}
	for i, d := range []string{"ok", "coach", "investigate", "false_detection", "escalated_external", "inconclusive"} {
		key := "d" + string(rune('a'+i))
		if _, _, err := db.InsertIfAbsent(incident(key, eventengine.StatusReview, time.Now())); err != nil {
			t.Fatal(err)
		}
		if err := db.Resolve(ctx, "INC-"+key, "mia", d, ""); err != nil {
			t.Errorf("disposition %q: %v", d, err)
		}
	}
	if _, _, err := db.InsertIfAbsent(incident("dz", eventengine.StatusReview, time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := db.Resolve(ctx, "INC-dz", "mia", "no_concern", ""); err == nil {
		t.Error("infant-era disposition must be refused by the schema")
	}
}

func TestUpdateUserEndsSessionsOnAccessChange(t *testing.T) {
	db, _ := pgtest.New(t)
	id, err := db.CreateUser(ctx, store.User{Username: "jane", DisplayName: "Jane", Role: "manager", PasswordHash: "x"})
	if err != nil {
		t.Fatal(err)
	}
	live := func(h string) bool {
		_, err := db.SessionUserNoTouch(ctx, h)
		return err == nil
	}
	if err := db.CreateSession(ctx, "s1", id, time.Minute); err != nil {
		t.Fatal(err)
	}
	name := "Jane D."
	u, err := db.UpdateUser(ctx, id, store.UserUpdate{DisplayName: &name})
	if err != nil || u.DisplayName != name || !live("s1") {
		t.Fatalf("rename: %+v %v live=%v", u, err, live("s1"))
	}
	role := "staff"
	if u, err := db.UpdateUser(ctx, id, store.UserUpdate{Role: &role}); err != nil || u.Role != "staff" || live("s1") {
		t.Fatalf("role change must end sessions: %+v %v", u, err)
	}
	if err := db.CreateSession(ctx, "s2", id, time.Minute); err != nil {
		t.Fatal(err)
	}
	off := true
	if u, err := db.UpdateUser(ctx, id, store.UserUpdate{Disabled: &off}); err != nil || !u.Disabled || live("s2") {
		t.Fatalf("disable must end sessions: %+v %v", u, err)
	}
	if _, err := db.UpdateUser(ctx, 999999, store.UserUpdate{DisplayName: &name}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown user: %v", err)
	}
	bad := "caregiver"
	if _, err := db.UpdateUser(ctx, id, store.UserUpdate{Role: &bad}); err == nil {
		t.Fatal("unknown role must be refused")
	}
}

func TestPOSEventsDeduplicated(t *testing.T) {
	db, _ := pgtest.New(t)
	amt := int64(4210)
	ev := eventengine.POSEvent{ID: "toast-1", RegisterID: "reg1", Type: "refund", TS: time.Now().UTC(), AmountCents: &amt, TicketRef: "T-1042"}
	if fresh, err := db.InsertPOSEvent(ctx, ev); err != nil || !fresh {
		t.Fatalf("first insert: %v %v", fresh, err)
	}
	if fresh, err := db.InsertPOSEvent(ctx, ev); err != nil || fresh {
		t.Fatalf("duplicate id must be reported as not fresh: %v %v", fresh, err)
	}
	if err := db.DeletePOSEvent(ctx, ev.ID); err != nil {
		t.Fatal(err)
	}
	if fresh, err := db.InsertPOSEvent(ctx, ev); err != nil || !fresh {
		t.Fatalf("after delete the event is new again: %v %v", fresh, err)
	}
	ev.ID, ev.Type = "toast-2", "chargeback"
	if _, err := db.InsertPOSEvent(ctx, ev); err == nil {
		t.Fatal("unknown POS event type must be refused by the schema")
	}
}

func TestAccessLogTrafficAndClipExists(t *testing.T) {
	db, _ := pgtest.New(t)
	t0 := time.Date(2026, 10, 31, 16, 0, 0, 0, time.UTC)
	for _, a := range []eventengine.ZoneAccess{
		{CameraID: "cam-back", RoomID: "back", RoomZone: "safe", ZoneID: "safe", Role: eventengine.RoleStaff, Start: t0, End: t0.Add(time.Minute)},
		{CameraID: "cam-back", RoomID: "back", RoomZone: "back-door", ZoneID: "back-door", Role: eventengine.RolePerson, Start: t0.Add(time.Hour), End: t0.Add(time.Hour + time.Second), AfterHours: true},
		{CameraID: "cam-back", RoomID: "back", RoomZone: "safe", ZoneID: "safe", Role: eventengine.RoleStaff, Start: t0, End: t0.Add(time.Minute)}, // replay
	} {
		if err := db.InsertZoneAccess(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	log, err := db.AccessLog(ctx, t0, t0.Add(2*time.Hour), 10)
	if err != nil || len(log) != 2 || log[0].ZoneID != "back-door" || !log[0].AfterHours || log[1].Role != "staff" {
		t.Fatalf("access log newest first: %+v %v", log, err)
	}
	if log, _ := db.AccessLog(ctx, t0.Add(time.Minute), t0.Add(2*time.Hour), 10); len(log) != 1 {
		t.Fatalf("from is inclusive of start only: %+v", log)
	}
	if log, _ := db.AccessLog(ctx, t0, t0.Add(2*time.Hour), 1); len(log) != 1 {
		t.Fatalf("limit: %+v", log)
	}

	for _, d := range []eventengine.TrafficDelta{
		{CameraID: "cam-entrance", Bucket: t0, Entries: 1},
		{CameraID: "cam-entrance", Bucket: t0, Entries: 1, Exits: 1, PeakOccupancy: 3},
		{CameraID: "cam-entrance", Bucket: t0, PeakOccupancy: 2},
		{CameraID: "cam-entrance", Bucket: t0.Add(eventengine.TrafficBucket), Exits: 1},
	} {
		if err := db.AddTraffic(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := db.Traffic(ctx, t0, t0.Add(time.Hour))
	if err != nil || len(rows) != 2 || rows[0].Entries != 2 || rows[0].Exits != 1 || rows[0].PeakOccupancy != 3 || rows[1].Exits != 1 {
		t.Fatalf("traffic: %+v %v", rows, err)
	}

	if _, _, err := db.InsertIfAbsent(incident("c1", eventengine.StatusReview, t0)); err != nil {
		t.Fatal(err)
	}
	if ok, err := db.ClipExists(ctx, "INC-c1", "cam-dining"); err != nil || ok {
		t.Fatalf("clip exists before insert: %v %v", ok, err)
	}
	clip := store.ClipRecord{ID: "INC-c1-cam-dining", IncidentID: "INC-c1", CameraID: "cam-dining", Path: "/a.enc", SHA256: "first",
		SizeBytes: 1, WrappedKey: []byte("k"), Start: t0, End: t0}
	if err := db.InsertClip(ctx, clip); err != nil {
		t.Fatal(err)
	}
	clip.SHA256, clip.Path = "second", "/b.enc"
	if err := db.InsertClip(ctx, clip); err != nil {
		t.Fatal(err)
	}
	got, err := db.Clip(ctx, clip.ID)
	if err != nil || got.SHA256 != "first" || got.Path != "/a.enc" {
		t.Fatalf("an existing clip record must never be overwritten: %+v %v", got, err)
	}
	if ok, err := db.ClipExists(ctx, "INC-c1", "cam-dining"); err != nil || !ok {
		t.Fatalf("clip exists after insert: %v %v", ok, err)
	}
}
