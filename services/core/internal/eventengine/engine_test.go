package eventengine

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

// t0 is Tuesday 2026-10-27 18:00 UTC = 14:00 in New York: open.
var t0 = time.Date(2026, 10, 27, 18, 0, 0, 0, time.UTC)

// night is Wednesday 03:00 in New York: closed, outside the staff window.
var night = time.Date(2026, 10, 28, 7, 0, 0, 0, time.UTC)

func rect(x1, y1, x2, y2 float64) []Point {
	return []Point{{x1, y1}, {x2, y1}, {x2, y2}, {x1, y2}}
}

func testSchedule(t *testing.T) *Schedule {
	t.Helper()
	week := map[string][][2]string{}
	for _, d := range []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"} {
		week[d] = [][2]string{{"11:00", "22:00"}}
	}
	s, err := NewSchedule(&BusinessHoursConfig{Timezone: "America/New_York", Weekly: week,
		StaffBeforeOpen: "90m", StaffAfterClose: "90m"})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func testCameras() []Camera {
	return []Camera{
		{ID: "cam-counter", RoomID: "counter", Zones: []Zone{
			{ID: "post", RoomZone: "register-1", Kind: ZonePost, Polygon: rect(0.3, 0.0, 0.7, 0.3)},
			{ID: "behind", RoomZone: "behind-counter", Kind: ZoneStaffArea, Polygon: rect(0.0, 0.0, 1.0, 0.4)},
			{ID: "front", RoomZone: "register-1-front", Kind: ZoneCustomerSide, Polygon: rect(0.25, 0.45, 0.75, 0.7)},
			{ID: "queue", RoomZone: "counter-queue", Kind: ZoneQueue, Polygon: rect(0.2, 0.45, 0.8, 1.0)},
			{ID: "office", RoomZone: "office", Kind: ZoneRestricted, Polygon: rect(0.85, 0.5, 1.0, 1.0)},
		}},
		{ID: "cam-dining", RoomID: "dining", Zones: []Zone{
			{ID: "floor", RoomZone: "dining-floor", Kind: ZoneFloor, Polygon: rect(0.0, 0.3, 1.0, 1.0)},
			{ID: "office-b", RoomZone: "office", Kind: ZoneRestricted, Polygon: rect(0.0, 0.4, 0.15, 1.0)},
		}},
		{ID: "cam-dining2", RoomID: "dining"},
		{ID: "cam-kitchen", RoomID: "kitchen", StaffOnly: true, Zones: []Zone{
			{ID: "cooler", RoomZone: "walk-in-cooler", Kind: ZoneSecure, Polygon: rect(0.7, 0.2, 1.0, 0.8)},
		}},
		{ID: "cam-entrance", RoomID: "entrance", Zones: []Zone{
			{ID: "line", RoomZone: "front-door", Kind: ZoneCountLine, Polygon: []Point{{0.2, 0.7}, {0.8, 0.7}}},
		}},
	}
}

func testSite(t *testing.T) Site {
	return Site{Schedule: testSchedule(t), Registers: []Register{
		{ID: "reg1", Name: "Register 1", CameraID: "cam-counter", CustomerZone: "front", RoomZone: "register-1"}}}
}

func newEngine(t *testing.T, s Store, overrides map[string]RuleOverride) *Engine {
	t.Helper()
	if err := ValidateOverrides(overrides); err != nil {
		t.Fatal(err)
	}
	return NewWithSite(testCameras(), DefaultRules(overrides), s, testSite(t))
}

func obsAt(cam string, at time.Time, tracks ...Track) Observation {
	return Observation{CameraID: cam, CaptureTS: at, Source: SourceMock, AIAvailable: true,
		ModelVersions: map[string]string{"detector": "mock-0"}, FrameSize: [2]int{1280, 720}, Tracks: tracks}
}

// person stands with feet at (x, y).
func person(id string, x, y float64) Track {
	return Track{ID: id, Role: RolePerson, Score: 0.9, Box: [4]float64{x - 0.04, math.Max(0, y-0.3), x + 0.04, y}, Visibility: 1}
}

// lying is a wide, short box centred on (x, y).
func lying(id string, x, y float64) Track {
	return Track{ID: id, Role: RolePerson, Score: 0.8, Box: [4]float64{x - 0.15, y - 0.05, x + 0.15, y + 0.05}, Visibility: 1}
}

// steps produces observations every 200 ms over [from, to) after base.
func steps(cam string, base time.Time, from, to time.Duration, tr func(time.Duration) []Track) []Observation {
	var out []Observation
	for d := from; d < to; d += 200 * time.Millisecond {
		out = append(out, obsAt(cam, base.Add(d), tr(d)...))
	}
	return out
}

func feed(t *testing.T, e *Engine, list ...Observation) []Output {
	t.Helper()
	var all []Output
	for _, o := range list {
		out, err := e.Process(o)
		if err != nil {
			t.Fatalf("process: %v", err)
		}
		all = append(all, out...)
	}
	return all
}

func incidents(t *testing.T, s Store, eventType string) []*Incident {
	t.Helper()
	l, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	var out []*Incident
	for _, i := range l {
		if eventType == "" || i.EventType == eventType {
			out = append(out, i)
		}
	}
	return out
}

func kinds(out []Output, kind string) []Output {
	var r []Output
	for _, o := range out {
		if o.Kind == kind {
			r = append(r, o)
		}
	}
	return r
}

// ---- restricted zone & staff inference -------------------------------------

func TestCustomerInRestrictedZoneCreatesOneReviewIncident(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-counter", t0, 0, 5*time.Second, func(time.Duration) []Track {
		return []Track{person("c1", 0.92, 0.8)}
	})...)
	got := incidents(t, s, "restricted_zone_entry")
	if len(got) != 1 || got[0].Status != StatusReview || got[0].RoomZone != "office" {
		t.Fatalf("want one REVIEW_QUEUED office incident, got %+v", got)
	}
}

func TestStaffInferredFromStaffAreaDoesNotTriggerRestricted(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	// 6 s behind the counter, then walks into the office.
	feed(t, e, steps("cam-counter", t0, 0, 6*time.Second, func(time.Duration) []Track {
		return []Track{person("s1", 0.5, 0.2)}
	})...)
	feed(t, e, steps("cam-counter", t0, 6*time.Second, 12*time.Second, func(time.Duration) []Track {
		return []Track{person("s1", 0.92, 0.8)}
	})...)
	if got := incidents(t, s, "restricted_zone_entry"); len(got) != 0 {
		t.Fatalf("staff must not trigger restricted entry, got %+v", got)
	}
}

func TestStaffOnlyCameraNeverRestricted(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	out := feed(t, e, steps("cam-kitchen", t0, 0, 6*time.Second, func(time.Duration) []Track {
		return []Track{person("k1", 0.85, 0.5)}
	})...)
	out = append(out, feed(t, e, obsAt("cam-kitchen", t0.Add(9*time.Second)))...)
	if got := incidents(t, s, "restricted_zone_entry"); len(got) != 0 {
		t.Fatalf("kitchen staff in cooler is not a restricted entry, got %+v", got)
	}
	acc := kinds(out, "zone_access")
	if len(acc) != 1 || acc[0].Access.Role != RoleStaff || acc[0].Access.ZoneID != "cooler" || acc[0].Access.AfterHours {
		t.Fatalf("want one staff cooler visit in the access log, got %+v", acc)
	}
}

// Regression (bug F1): a second, separate event in the same zone within the
// same minute used to collide with the first incident's idempotency key and
// was silently dropped.
func TestSecondEventSameMinuteIsNotDropped(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	in := func(id string) func(time.Duration) []Track {
		return func(time.Duration) []Track { return []Track{person(id, 0.92, 0.8)} }
	}
	feed(t, e, steps("cam-counter", t0, 0, 4*time.Second, in("c1"))...)
	feed(t, e, steps("cam-counter", t0, 4*time.Second, 6*time.Second, func(time.Duration) []Track { return nil })...)
	// Beyond the 1-minute merge gap but... same minute bucket is impossible
	// with a 60 s gap, so shrink the gap to prove keys no longer collide.
	e2 := NewWithSite(testCameras(), DefaultRules(nil), s, testSite(t))
	for _, r := range e2.rules {
		if rz, ok := r.(*RestrictedZoneEntry); ok {
			rz.Cfg.MergeGap = time.Second
		}
	}
	feed(t, e2, steps("cam-counter", t0, 30*time.Second, 35*time.Second, in("c2"))...)
	if got := incidents(t, s, "restricted_zone_entry"); len(got) != 2 {
		t.Fatalf("want 2 incidents for 2 separate entries in the same minute, got %d", len(got))
	}
}

func TestReplayIsIdempotent(t *testing.T) {
	s := NewMemoryStore()
	list := steps("cam-counter", t0, 0, 5*time.Second, func(time.Duration) []Track { return []Track{person("c1", 0.92, 0.8)} })
	feed(t, newEngine(t, s, nil), list...)
	feed(t, newEngine(t, s, nil), list...)
	if got := incidents(t, s, ""); len(got) != 1 {
		t.Fatalf("replay must not duplicate incidents, got %d", len(got))
	}
}

// failingStore fails inserts until healed.
type failingStore struct {
	*MemoryStore
	fail bool
}

func (f *failingStore) InsertIfAbsent(inc *Incident) (*Incident, bool, error) {
	if f.fail {
		return nil, false, errors.New("database unavailable")
	}
	return f.MemoryStore.InsertIfAbsent(inc)
}

// Regression (bug F2): a database error during finalize used to lose the
// candidate, so the event was never recorded.
func TestDatabaseErrorDoesNotLoseIncident(t *testing.T) {
	fs := &failingStore{MemoryStore: NewMemoryStore(), fail: true}
	e := newEngine(t, fs, nil)
	sawErr := false
	for _, o := range steps("cam-counter", t0, 0, 4*time.Second, func(time.Duration) []Track { return []Track{person("c1", 0.92, 0.8)} }) {
		if _, err := e.Process(o); err != nil {
			sawErr = true
		}
	}
	if !sawErr {
		t.Fatal("expected the failing store to surface an error")
	}
	// The person leaves while the database is still down: the loss path must
	// not drop the pending incident either.
	if _, err := e.Process(obsAt("cam-counter", t0.Add(6*time.Second))); err == nil {
		t.Fatal("expected error while database is down")
	}
	fs.fail = false
	feed(t, e, obsAt("cam-counter", t0.Add(7*time.Second)))
	if got := incidents(t, fs, "restricted_zone_entry"); len(got) != 1 {
		t.Fatalf("incident must be recorded once the database is back, got %d", len(got))
	}
}

// ---- after-hours intrusion ---------------------------------------------------

func TestAfterHoursIntrusionShadowByDefaultAndAlertWhenEnabled(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		s := NewMemoryStore()
		e := newEngine(t, s, map[string]RuleOverride{"after_hours_intrusion": {AlertingEnabled: enabled}})
		feed(t, e, steps("cam-dining", night, 0, 3*time.Second, func(time.Duration) []Track {
			return []Track{person("x", 0.5, 0.9)}
		})...)
		got := incidents(t, s, "after_hours_intrusion")
		want := StatusShadow
		if enabled {
			want = StatusAlerted
		}
		if len(got) != 1 || got[0].Status != want {
			t.Fatalf("enabled=%v: want one %s intrusion, got %+v", enabled, want, got)
		}
	}
}

func TestNoIntrusionDuringStaffWindow(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	// 22:30 local: closed, but within the 90 min after-close staff allowance.
	late := time.Date(2026, 10, 28, 2, 30, 0, 0, time.UTC)
	feed(t, e, steps("cam-dining", late, 0, 5*time.Second, func(time.Duration) []Track { return []Track{person("x", 0.5, 0.9)} })...)
	if got := incidents(t, s, "after_hours_intrusion"); len(got) != 0 {
		t.Fatalf("closing staff must not be an intrusion, got %+v", got)
	}
}

func TestIntrusionLostBeforeConfirmationIsInconclusive(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-dining", night, 0, time.Second, func(time.Duration) []Track { return []Track{person("x", 0.5, 0.9)} })...)
	feed(t, e, steps("cam-dining", night, time.Second, 3*time.Second, func(time.Duration) []Track { return nil })...)
	got := incidents(t, s, "after_hours_intrusion")
	if len(got) != 1 || got[0].Status != StatusInconclusive {
		t.Fatalf("losing sight of an intruder must be INCONCLUSIVE, not nothing: %+v", got)
	}
}

func TestIntrusionOnTwoCamerasMergesInOneRoom(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-dining", night, 0, 3*time.Second, func(time.Duration) []Track { return []Track{person("x", 0.5, 0.9)} })...)
	out := feed(t, e, steps("cam-dining2", night, time.Second, 4*time.Second, func(time.Duration) []Track { return []Track{person("y", 0.5, 0.9)} })...)
	got := incidents(t, s, "after_hours_intrusion")
	if len(got) != 1 || len(got[0].Cameras) != 2 || len(kinds(out, "incident_merged")) != 1 {
		t.Fatalf("want one incident seen by two cameras, got %+v", got)
	}
}

// ---- person down ---------------------------------------------------------------

func TestPersonDownInFloorZone(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-dining", t0, 0, 4*time.Second, func(time.Duration) []Track { return []Track{lying("f", 0.5, 0.8)} })...)
	got := incidents(t, s, "person_down")
	if len(got) != 1 || got[0].Status != StatusShadow {
		t.Fatalf("want one SHADOW person_down, got %+v", got)
	}
}

func TestPersonDownIgnoresStandingAndCamerasWithoutFloor(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-dining", t0, 0, 5*time.Second, func(time.Duration) []Track { return []Track{person("p", 0.5, 0.9)} })...)
	feed(t, e, steps("cam-counter", t0, 0, 5*time.Second, func(time.Duration) []Track { return []Track{lying("o", 0.5, 0.2)} })...)
	if got := incidents(t, s, "person_down"); len(got) != 0 {
		t.Fatalf("standing people and overhead cameras must not trigger, got %+v", got)
	}
}

// ---- queues & posts ---------------------------------------------------------------

func crowd(n int) []Track {
	var ts []Track
	for i := 0; i < n; i++ {
		ts = append(ts, person(string(rune('a'+i)), 0.3+0.08*float64(i), 0.9))
	}
	return ts
}

func TestLongQueueDuringOpenHoursOnly(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, map[string]RuleOverride{"long_queue": {AlertingEnabled: true}})
	feed(t, e, steps("cam-counter", t0, 0, 61*time.Second, func(time.Duration) []Track { return crowd(5) })...)
	got := incidents(t, s, "long_queue")
	if len(got) != 1 || got[0].Status != StatusAlerted {
		t.Fatalf("want one alerted long_queue, got %+v", got)
	}
	s2 := NewMemoryStore()
	e2 := newEngine(t, s2, nil)
	feed(t, e2, steps("cam-counter", night, 0, 61*time.Second, func(time.Duration) []Track { return crowd(5) })...)
	if got := incidents(t, s2, "long_queue"); len(got) != 0 {
		t.Fatalf("no queue alerts when closed, got %+v", got)
	}
}

func TestShortQueueDoesNotTrigger(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-counter", t0, 0, 70*time.Second, func(time.Duration) []Track { return crowd(4) })...)
	if got := incidents(t, s, "long_queue"); len(got) != 0 {
		t.Fatalf("4 people is under the threshold, got %+v", got)
	}
}

func TestUnattendedPost(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-counter", t0, 0, 181*time.Second, func(time.Duration) []Track { return nil })...)
	got := incidents(t, s, "unattended_post")
	if len(got) != 1 || got[0].RoomZone != "register-1" {
		t.Fatalf("want one unattended_post, got %+v", got)
	}
	s2 := NewMemoryStore()
	e2 := newEngine(t, s2, nil)
	feed(t, e2, steps("cam-counter", t0, 0, 181*time.Second, func(d time.Duration) []Track {
		if d < 100*time.Second {
			return nil
		}
		return []Track{person("s", 0.5, 0.2)}
	})...)
	if got := incidents(t, s2, "unattended_post"); len(got) != 0 {
		t.Fatalf("someone returned to the post before 3 min, got %+v", got)
	}
}

func TestLongWaitTrackLossIsNotInconclusive(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	feed(t, e, steps("cam-counter", t0, 0, 5*time.Minute, func(time.Duration) []Track { return []Track{person("w", 0.5, 0.9)} })...)
	feed(t, e, steps("cam-counter", t0, 5*time.Minute, 5*time.Minute+3*time.Second, func(time.Duration) []Track { return nil })...)
	if got := incidents(t, s, "long_wait"); len(got) != 0 {
		t.Fatalf("an ID switch at a busy counter must not create review noise, got %+v", got)
	}
	feed(t, e, steps("cam-counter", t0, 6*time.Minute, 14*time.Minute+time.Second, func(time.Duration) []Track { return []Track{person("w2", 0.5, 0.9)} })...)
	if got := incidents(t, s, "long_wait"); len(got) != 1 || got[0].Status != StatusReview {
		t.Fatalf("want one long_wait review after 8 min, got %+v", got)
	}
}

// ---- camera tamper & clocks --------------------------------------------------------

func TestCameraCoveredBecomesTamperIncident(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, map[string]RuleOverride{"camera_tamper": {AlertingEnabled: true}})
	var list []Observation
	for d := time.Duration(0); d <= 31*time.Second; d += 500 * time.Millisecond {
		o := obsAt("cam-dining", t0.Add(d))
		o.Quality = Quality{Degraded: true, Reason: "obstructed"}
		list = append(list, o)
	}
	feed(t, e, list...)
	got := incidents(t, s, "camera_tamper")
	if len(got) != 1 || got[0].Status != StatusAlerted || !strings.Contains(got[0].Detail, "obstructed") {
		t.Fatalf("want one alerted camera_tamper (obstructed), got %+v", got)
	}
}

func TestCameraOfflineBecomesTamperViaTick(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	o := obsAt("cam-dining", t0)
	o.ReceivedAt = t0
	feed(t, e, o)
	for d := time.Second; d <= 40*time.Second; d += time.Second {
		if _, err := e.Tick(t0.Add(d)); err != nil {
			t.Fatal(err)
		}
	}
	got := incidents(t, s, "camera_tamper")
	if len(got) != 1 || !strings.Contains(got[0].Detail, "offline") {
		t.Fatalf("want camera_tamper for an offline camera, got %+v", got)
	}
}

// Regression (bug F4): Tick runs on the wall clock while observations carry the
// camera's capture clock. A camera whose clock lags must not flap to
// unavailable while observations keep arriving.
func TestCameraClockSkewDoesNotFlapState(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	skew := 10 * time.Second // camera clock 10 s behind
	for d := time.Duration(0); d < 6*time.Second; d += 200 * time.Millisecond {
		wall := t0.Add(d)
		o := obsAt("cam-counter", wall.Add(-skew), person("c1", 0.92, 0.8))
		o.ReceivedAt = wall
		out := feed(t, e, o)
		tick, err := e.Tick(wall.Add(100 * time.Millisecond))
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range append(out, tick...) {
			if ev.Kind == "state_change" && ev.CameraID == "cam-counter" && ev.State != StateOperational {
				t.Fatalf("camera flapped to %s at +%s", ev.State, d)
			}
		}
	}
	if got := incidents(t, s, "restricted_zone_entry"); len(got) != 1 || got[0].Status != StatusReview {
		t.Fatalf("a lagging camera clock must still confirm events, got %+v", got)
	}
}

func TestDegradedVideoNeverAnalysed(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	var list []Observation
	for d := time.Duration(0); d < 5*time.Second; d += 200 * time.Millisecond {
		o := obsAt("cam-counter", t0.Add(d), person("c1", 0.92, 0.8))
		o.Quality = Quality{Degraded: true, Reason: "black"}
		list = append(list, o)
	}
	out := feed(t, e, list...)
	if got := incidents(t, s, "restricted_zone_entry"); len(got) != 0 {
		t.Fatalf("rules must not run on degraded video, got %+v", got)
	}
	if st := kinds(out, "state_change"); len(st) == 0 || st[0].State != StateVideoDegraded {
		t.Fatalf("want VIDEO_DEGRADED state, got %+v", st)
	}
}

// ---- POS -------------------------------------------------------------------------

func amount(c int64) *int64 { return &c }

func TestNoSaleIsReviewedWithTicket(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	out, err := e.ProcessPOS(POSEvent{ID: "p1", RegisterID: "reg1", Type: "no_sale", TS: t0, TicketRef: "T-1", EmployeeRef: "E-7"})
	if err != nil {
		t.Fatal(err)
	}
	got := incidents(t, s, "pos_no_sale")
	if len(got) != 1 || got[0].Status != StatusReview || got[0].PosRef != "T-1" || got[0].Source != SourcePOS ||
		len(kinds(out, "incident_created")) != 1 || kinds(out, "incident_created")[0].CameraID != "cam-counter" {
		t.Fatalf("want one review no-sale incident on the register camera, got %+v / %+v", got, out)
	}
	if _, err := e.ProcessPOS(POSEvent{ID: "p1", RegisterID: "reg1", Type: "no_sale", TS: t0}); err != nil {
		t.Fatal(err)
	}
	if got := incidents(t, s, "pos_no_sale"); len(got) != 1 {
		t.Fatalf("a resent POS event must not duplicate, got %d", len(got))
	}
}

func TestUnknownRegister(t *testing.T) {
	e := newEngine(t, NewMemoryStore(), nil)
	if _, err := e.ProcessPOS(POSEvent{ID: "x", RegisterID: "nope", Type: "refund", TS: t0}); !errors.Is(err, ErrUnknownRegister) {
		t.Fatalf("want ErrUnknownRegister, got %v", err)
	}
}

func refundScenario(t *testing.T, customer bool) *MemoryStore {
	t.Helper()
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	staffer := person("s", 0.5, 0.2)
	tracks := func(d time.Duration) []Track {
		if customer && d > 15*time.Second && d < 25*time.Second {
			return []Track{staffer, person("c", 0.5, 0.6)}
		}
		return []Track{staffer}
	}
	feed(t, e, steps("cam-counter", t0, 0, 30*time.Second, tracks)...)
	if _, err := e.ProcessPOS(POSEvent{ID: "r1", RegisterID: "reg1", Type: "refund", TS: t0.Add(28 * time.Second), AmountCents: amount(4210), TicketRef: "T-9"}); err != nil {
		t.Fatal(err)
	}
	if got := incidents(t, s, "pos_refund_no_customer"); len(got) != 0 {
		t.Fatalf("must wait until video passes the window end, got %+v", got)
	}
	feed(t, e, steps("cam-counter", t0, 30*time.Second, 40*time.Second, tracks)...)
	return s
}

func TestRefundWithNobodyAtCounter(t *testing.T) {
	got := incidents(t, refundScenario(t, false), "pos_refund_no_customer")
	if len(got) != 1 || got[0].Status != StatusShadow || !strings.Contains(got[0].Detail, "$42.10") || got[0].PosRef != "T-9" {
		t.Fatalf("want one SHADOW refund incident, got %+v", got)
	}
}

func TestRefundWithCustomerPresentIsFine(t *testing.T) {
	if got := incidents(t, refundScenario(t, true), "pos_refund_no_customer"); len(got) != 0 {
		t.Fatalf("customer was at the counter, got %+v", got)
	}
}

func TestRefundWhileCameraDownIsInconclusive(t *testing.T) {
	s := NewMemoryStore()
	e := newEngine(t, s, nil)
	o := obsAt("cam-counter", t0)
	o.ReceivedAt = t0
	feed(t, e, o)
	if _, err := e.ProcessPOS(POSEvent{ID: "r2", RegisterID: "reg1", Type: "void", TS: t0.Add(10 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	for d := time.Second; d <= 20*time.Second; d += time.Second {
		if _, err := e.Tick(t0.Add(d)); err != nil {
			t.Fatal(err)
		}
	}
	got := incidents(t, s, "pos_refund_no_customer")
	if len(got) != 1 || got[0].Status != StatusInconclusive {
		t.Fatalf("an unwatched void must be INCONCLUSIVE, got %+v", got)
	}
}

// ---- traffic & access log ------------------------------------------------------------

func TestCountLineEntriesExitsAndPeak(t *testing.T) {
	e := newEngine(t, NewMemoryStore(), nil)
	walk := func(id string, fromY, toY float64, start time.Duration) []Observation {
		var l []Observation
		for i := 0; i <= 10; i++ {
			y := fromY + (toY-fromY)*float64(i)/10
			l = append(l, obsAt("cam-entrance", t0.Add(start+time.Duration(i)*200*time.Millisecond), person(id, 0.5, y)))
		}
		return l
	}
	out := feed(t, e, walk("in1", 0.5, 0.9, 0)...)
	out = append(out, feed(t, e, walk("out1", 0.9, 0.5, 5*time.Second)...)...)
	out = append(out, feed(t, e, walk("side", 0.5, 0.9, 10*time.Second)...)...) // also an entry
	entries, exits, peak := 0, 0, 0
	for _, o := range kinds(out, "traffic") {
		entries += o.Traffic.Entries
		exits += o.Traffic.Exits
		if o.Traffic.PeakOccupancy > peak {
			peak = o.Traffic.PeakOccupancy
		}
		if !o.Traffic.Bucket.Equal(t0.Truncate(TrafficBucket)) {
			t.Fatalf("bucket %v, want %v", o.Traffic.Bucket, t0)
		}
	}
	if entries != 2 || exits != 1 || peak != 1 {
		t.Fatalf("entries=%d exits=%d peak=%d, want 2/1/1", entries, exits, peak)
	}
}

func TestCountLineIgnoresCrossingOutsideSegment(t *testing.T) {
	e := newEngine(t, NewMemoryStore(), nil)
	var out []Output
	for i := 0; i <= 10; i++ {
		y := 0.5 + 0.04*float64(i)
		out = append(out, feed(t, e, obsAt("cam-entrance", t0.Add(time.Duration(i)*200*time.Millisecond), person("p", 0.95, y)))...)
	}
	for _, o := range kinds(out, "traffic") {
		if o.Traffic.Entries+o.Traffic.Exits != 0 {
			t.Fatalf("walking past the end of the door line is not an entry: %+v", o.Traffic)
		}
	}
}

func TestAfterHoursCoolerVisitFlagged(t *testing.T) {
	e := newEngine(t, NewMemoryStore(), nil)
	out := feed(t, e, steps("cam-kitchen", night, 0, 3*time.Second, func(time.Duration) []Track { return []Track{person("k", 0.85, 0.5)} })...)
	out = append(out, feed(t, e, obsAt("cam-kitchen", night.Add(6*time.Second)))...)
	acc := kinds(out, "zone_access")
	if len(acc) != 1 || !acc[0].Access.AfterHours {
		t.Fatalf("want one after-hours cooler visit, got %+v", acc)
	}
}

// ---- schedule & validation ----------------------------------------------------------

func TestScheduleCrossesMidnight(t *testing.T) {
	s, err := NewSchedule(&BusinessHoursConfig{Timezone: "UTC", Weekly: map[string][][2]string{"fri": {{"18:00", "02:00"}}}})
	if err != nil {
		t.Fatal(err)
	}
	fri := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC) // a Friday
	for _, c := range []struct {
		at   time.Time
		open bool
	}{
		{fri.Add(17 * time.Hour), false},
		{fri.Add(23 * time.Hour), true},
		{fri.Add(25 * time.Hour), true}, // Saturday 01:00
		{fri.Add(26*time.Hour + time.Minute), false},
	} {
		if s.IsOpen(c.at) != c.open {
			t.Errorf("IsOpen(%s) = %v, want %v", c.at, !c.open, c.open)
		}
	}
	if !(*Schedule)(nil).IsOpen(fri) || !(*Schedule)(nil).InStaffWindow(fri) {
		t.Error("no schedule means always open")
	}
}

func TestScheduleRejectsBadConfig(t *testing.T) {
	for _, c := range []BusinessHoursConfig{
		{Timezone: ""},
		{Timezone: "Mars/Olympus"},
		{Timezone: "UTC", Weekly: map[string][][2]string{"funday": {{"10:00", "11:00"}}}},
		{Timezone: "UTC", Weekly: map[string][][2]string{"mon": {{"25:00", "11:00"}}}},
		{Timezone: "UTC", StaffBeforeOpen: "forever"},
	} {
		if _, err := NewSchedule(&c); err == nil {
			t.Errorf("want error for %+v", c)
		}
	}
}

func TestValidateRejectsBadObservations(t *testing.T) {
	bad := []Observation{
		{CaptureTS: t0, Source: "x"},
		{CameraID: "c", Source: "x"},
		{CameraID: "c", CaptureTS: t0},
		obsAt("c", t0, Track{ID: "1", Role: "infant", Score: 1}),
		obsAt("c", t0, Track{ID: "1", Role: RolePerson, Score: math.NaN()}),
		obsAt("c", t0, Track{ID: "1", Role: RolePerson, Score: 0.5, Box: [4]float64{0.5, 0.5, 0.4, 0.6}}),
	}
	for i, o := range bad {
		if err := o.Validate(); err == nil {
			t.Errorf("case %d: want validation error", i)
		}
	}
}

func TestValidateOverrides(t *testing.T) {
	if err := ValidateOverrides(map[string]RuleOverride{"infant_off_surface": {}}); err == nil {
		t.Error("unknown rule must be rejected")
	}
	if err := ValidateOverrides(map[string]RuleOverride{"person_down": {MaxPeople: 3}}); err == nil {
		t.Error("max_people only applies to long_queue")
	}
	if err := ValidateOverrides(map[string]RuleOverride{"long_queue": {MaxPeople: 8, AlertingEnabled: true}}); err != nil {
		t.Error(err)
	}
}
