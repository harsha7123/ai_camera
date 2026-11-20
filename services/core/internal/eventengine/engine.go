package eventengine

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

// IncidentStatus is the initial routing decision for an incident.
type IncidentStatus string

const (
	StatusAlerted      IncidentStatus = "ALERTED"       // staff are notified
	StatusReview       IncidentStatus = "REVIEW_QUEUED" // goes to the exception queue
	StatusShadow       IncidentStatus = "SHADOW"        // alert policy, alerting not enabled yet: owners only
	StatusInconclusive IncidentStatus = "INCONCLUSIVE"  // evidence lost before the rule could decide
)

// Incident is a possible event requiring human review. It is never a finding.
type Incident struct {
	ID             string            `json:"id"`
	IdempotencyKey string            `json:"idempotency_key"`
	RoomID         string            `json:"room_id"`
	RoomZone       string            `json:"room_zone"`
	EventType      string            `json:"event_type"`
	Family         string            `json:"family"`
	Start          time.Time         `json:"start"`
	End            time.Time         `json:"end"`
	Cameras        []string          `json:"cameras"`
	Status         IncidentStatus    `json:"status"`
	RuleVersion    string            `json:"rule_version"`
	ModelVersions  map[string]string `json:"model_versions"`
	Source         string            `json:"source"`
	Detail         string            `json:"detail"`
	PosRef         string            `json:"pos_ref,omitempty"`
}

func (i *Incident) addCamera(id string) {
	for _, c := range i.Cameras {
		if c == id {
			return
		}
	}
	i.Cameras = append(i.Cameras, id)
	sort.Strings(i.Cameras)
}

// Output is everything the engine reports to the rest of core.
type Output struct {
	// state_change | incident_created | incident_merged | zone_access | traffic
	Kind     string          `json:"kind"`
	CameraID string          `json:"camera_id,omitempty"`
	State    MonitoringState `json:"state,omitempty"`
	Incident *Incident       `json:"incident,omitempty"`
	Access   *ZoneAccess     `json:"access,omitempty"`
	Traffic  *TrafficDelta   `json:"traffic,omitempty"`
}

type candKey struct{ camera, subject, event string }

type candidate struct {
	rule       Rule
	start      time.Time
	lastSeen   time.Time
	extendedAt time.Time
	roomZone   string
	detail     string
	source     string
	models     map[string]string
	incidentID string // set once confirmed
}

// extendEvery throttles end-time updates of an ongoing incident, so a long
// event does not write to the database on every frame.
const extendEvery = 5 * time.Second

// Site is the per-site configuration beyond cameras and rules.
type Site struct {
	Schedule  *Schedule
	Registers []Register
}

// Engine is not safe for concurrent use; core feeds it from one goroutine per
// site so observations stay ordered.
type Engine struct {
	cameras        map[string]Camera
	rules          []Rule
	store          Store
	staleAfter     time.Duration
	trackLostAfter time.Duration
	schedule       *Schedule
	registers      map[string]Register

	tamperRule *CameraTamper
	noSaleRule *POSNoSale
	refundRule *POSRefundNoCustomer

	health   map[string]*cameraHealth
	reported map[string]MonitoringState
	cands    map[candKey]*candidate
	tamper   map[string]*candidate
	staff    map[trackKey]*trackMemory
	visits   map[visitKey]*visit
	lines    map[visitKey]*lineMemory
	traffic  map[string]*bucketPeak
	presence map[presenceKey][]interval
	pending  []*posCheck
}

// New builds an engine with no business hours and no registers.
func New(cameras []Camera, rules []Rule, store Store) *Engine {
	return NewWithSite(cameras, rules, store, Site{})
}

// NewWithSite builds an engine for one site.
func NewWithSite(cameras []Camera, rules []Rule, store Store, site Site) *Engine {
	cm := make(map[string]Camera, len(cameras))
	for _, c := range cameras {
		cm[c.ID] = c
	}
	regs := make(map[string]Register, len(site.Registers))
	for _, r := range site.Registers {
		regs[r.ID] = r
	}
	e := &Engine{
		cameras:        cm,
		store:          store,
		staleAfter:     defaultStaleAfter,
		trackLostAfter: time.Second,
		schedule:       site.Schedule,
		registers:      regs,
		health:         map[string]*cameraHealth{},
		reported:       map[string]MonitoringState{},
		cands:          map[candKey]*candidate{},
		tamper:         map[string]*candidate{},
		staff:          map[trackKey]*trackMemory{},
		visits:         map[visitKey]*visit{},
		lines:          map[visitKey]*lineMemory{},
		traffic:        map[string]*bucketPeak{},
		presence:       map[presenceKey][]interval{},
	}
	for _, r := range rules {
		switch rr := r.(type) {
		case *CameraTamper:
			e.tamperRule = rr
		case *POSNoSale:
			e.noSaleRule = rr
		case *POSRefundNoCustomer:
			e.refundRule = rr
		default:
			e.rules = append(e.rules, r)
		}
	}
	return e
}

// Schedule returns the site's business hours (nil if none configured).
func (e *Engine) Schedule() *Schedule { return e.schedule }

// State returns the camera's monitoring state at wall-clock time now.
func (e *Engine) State(cameraID string, now time.Time) MonitoringState {
	h, ok := e.health[cameraID]
	if !ok {
		return StateNeverConnected
	}
	return h.stateAt(now, e.staleAfter)
}

// camNow maps a wall-clock instant onto the camera's capture clock, so
// timeouts measured by Tick and by observations agree even when the camera's
// clock is skewed or the pipeline lags.
func (e *Engine) camNow(cameraID string, wall time.Time) time.Time {
	h := e.health[cameraID]
	if h == nil || h.lastRecv.IsZero() {
		return wall
	}
	return h.lastCapture.Add(wall.Sub(h.lastRecv))
}

// Tick re-evaluates health without a new observation, so a camera that stops
// sending is reported unavailable rather than staying at its last state. now
// is wall-clock time.
func (e *Engine) Tick(now time.Time) ([]Output, error) {
	var out []Output
	ids := make([]string, 0, len(e.cameras))
	for id := range e.cameras {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var firstErr error
	keep := func(o []Output, err error) {
		out = append(out, o...)
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	for _, id := range ids {
		cam := e.cameras[id]
		st := e.State(id, now)
		cn := e.camNow(id, now)
		out = append(out, e.reportState(id, st)...)
		h := e.health[id]
		if h != nil {
			keep(e.stepTamper(cam, st, cn, h))
		}
		if !st.Analyzable() {
			keep(e.closeCandidates(id, func(*candidate) bool { return true }))
			out = append(out, e.closeVisits(id, cn, true)...)
		}
		keep(e.evaluatePOS(id, cn))
		e.prune(id, cn)
	}
	return out, firstErr
}

// Process consumes one observation. Observations for a camera must arrive in
// capture order.
func (e *Engine) Process(obs Observation) ([]Output, error) {
	if err := obs.Validate(); err != nil {
		return nil, err
	}
	cam, ok := e.cameras[obs.CameraID]
	if !ok {
		return nil, fmt.Errorf("observation for unregistered camera %q", obs.CameraID)
	}
	h := e.health[cam.ID]
	if h == nil {
		h = &cameraHealth{}
		e.health[cam.ID] = h
	}
	h.lastRecv, h.lastCapture = obs.received(), obs.CaptureTS
	h.lastQuality, h.aiAvailable = obs.Quality, obs.AIAvailable
	h.lastSource, h.lastModels = obs.Source, obs.ModelVersions

	st := h.stateAt(h.lastRecv, e.staleAfter)
	out := e.reportState(cam.ID, st)
	o, err := e.stepTamper(cam, st, obs.CaptureTS, h)
	out = append(out, o...)
	if err != nil {
		return out, err
	}
	if !st.Analyzable() {
		o, err := e.closeCandidates(cam.ID, func(*candidate) bool { return true })
		out = append(out, o...)
		out = append(out, e.closeVisits(cam.ID, obs.CaptureTS, true)...)
		if err != nil {
			return out, err
		}
		o, err = e.evaluatePOS(cam.ID, obs.CaptureTS)
		return append(out, o...), err
	}
	h.noteCoverage(obs.CaptureTS)

	fc := &FrameContext{
		Cam: cam, Obs: obs, Roles: e.resolveRoles(cam, obs),
		Open: e.schedule.IsOpen(obs.CaptureTS), StaffWindow: e.schedule.InStaffWindow(obs.CaptureTS),
	}
	for _, r := range e.rules {
		for _, v := range r.Evaluate(fc) {
			o, err := e.step(cam, obs, v, r)
			out = append(out, o...)
			if err != nil {
				return out, err
			}
		}
	}

	o, err = e.closeCandidates(cam.ID, func(c *candidate) bool {
		return obs.CaptureTS.Sub(c.lastSeen) > e.trackLostAfter
	})
	out = append(out, o...)
	if err != nil {
		return out, err
	}
	out = append(out, e.analytics(fc)...)
	o, err = e.evaluatePOS(cam.ID, obs.CaptureTS)
	return append(out, o...), err
}

func (e *Engine) step(cam Camera, obs Observation, v Verdict, r Rule) ([]Output, error) {
	key := candKey{cam.ID, v.Subject, r.EventType()}
	c := e.cands[key]
	ts := obs.CaptureTS
	cfg := r.Config()

	switch {
	case c == nil:
		if v.Trigger && v.EvidenceOK {
			e.cands[key] = &candidate{rule: r, start: ts, lastSeen: ts, roomZone: v.RoomZone, detail: v.Detail,
				source: obs.Source, models: obs.ModelVersions}
		}
		return nil, nil

	case c.incidentID != "":
		if !v.Trigger {
			delete(e.cands, key)
			return nil, e.extend(c, c.lastSeen, true)
		}
		c.lastSeen = ts
		return nil, e.extend(c, ts, false)

	case !v.EvidenceOK:
		if !cfg.InconclusiveOnLoss {
			delete(e.cands, key)
			return nil, nil
		}
		out, err := e.finalize(cam, ts, c, StatusInconclusive)
		if err != nil {
			return nil, err // keep the candidate: retried on the next frame
		}
		delete(e.cands, key)
		return out, nil

	case !v.Trigger:
		delete(e.cands, key) // did not persist: discarded
		return nil, nil

	default:
		c.lastSeen = ts
		if ts.Sub(c.start) < cfg.MinDuration {
			return nil, nil
		}
		// On error the candidate stays unconfirmed and is retried next frame.
		return e.finalize(cam, ts, c, initialStatus(cfg))
	}
}

var statusRank = map[IncidentStatus]int{StatusInconclusive: 0, StatusReview: 1, StatusShadow: 2, StatusAlerted: 3}

func initialStatus(cfg RuleConfig) IncidentStatus {
	switch {
	case cfg.Policy == PolicyAlert && cfg.AlertingEnabled:
		return StatusAlerted
	case cfg.Policy == PolicyAlert:
		return StatusShadow
	default:
		return StatusReview
	}
}

// idempotencyKey identifies one candidate exactly. Replaying the same input
// produces the same key (so a replay never duplicates an incident), while two
// different events can never collide: the key includes the camera, the
// subject and the exact start time, not a coarse time bucket.
func idempotencyKey(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// finalize creates an incident for the candidate, or merges it into an open
// incident of the same event type in the same room zone.
func (e *Engine) finalize(cam Camera, ts time.Time, c *candidate, status IncidentStatus) ([]Output, error) {
	cfg := c.rule.Config()
	existing, err := e.store.FindMergeable(cam.RoomID, c.roomZone, c.rule.EventType(), c.start, cfg.MergeGap)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		existing.addCamera(cam.ID)
		if ts.After(existing.End) {
			existing.End = ts
		}
		if c.start.Before(existing.Start) {
			existing.Start = c.start
		}
		if statusRank[status] > statusRank[existing.Status] {
			existing.Status = status // confirmed evidence outranks an earlier inconclusive window
		}
		if err := e.store.Update(existing); err != nil {
			return nil, err
		}
		c.incidentID, c.extendedAt = existing.ID, ts
		return []Output{{Kind: "incident_merged", CameraID: cam.ID, Incident: existing}}, nil
	}

	idem := idempotencyKey(cam.ID, c.rule.EventType(), c.roomZone, c.start.UTC().Format(time.RFC3339Nano))
	inc := &Incident{
		ID:             "INC-" + idem[:12],
		IdempotencyKey: idem,
		RoomID:         cam.RoomID,
		RoomZone:       c.roomZone,
		EventType:      c.rule.EventType(),
		Family:         c.rule.Family(),
		Start:          c.start,
		End:            ts,
		Cameras:        []string{cam.ID},
		Status:         status,
		RuleVersion:    c.rule.Version(),
		ModelVersions:  c.models,
		Source:         c.source,
		Detail:         c.detail,
	}
	stored, created, err := e.store.InsertIfAbsent(inc)
	if err != nil {
		return nil, err
	}
	c.incidentID, c.extendedAt = stored.ID, ts
	if !created {
		return nil, nil // the same candidate was already recorded (replay)
	}
	return []Output{{Kind: "incident_created", CameraID: cam.ID, Incident: stored}}, nil
}

// extend moves a confirmed incident's end forward. Unless final, it writes at
// most every extendEvery.
func (e *Engine) extend(c *candidate, ts time.Time, final bool) error {
	if !final && ts.Sub(c.extendedAt) < extendEvery {
		return nil
	}
	inc, err := e.store.Get(c.incidentID)
	if err != nil || inc == nil || !ts.After(inc.End) {
		return err
	}
	inc.End = ts
	if err := e.store.Update(inc); err != nil {
		return err
	}
	c.extendedAt = ts
	return nil
}

// closeCandidates ends open candidates on a camera whose subject is gone or
// whose camera stopped being analysable. Unconfirmed candidates of rules with
// InconclusiveOnLoss become INCONCLUSIVE incidents: losing sight of someone is
// never treated as "nothing happened". A candidate is only forgotten once its
// incident is safely stored, so a database error is retried, not lost.
func (e *Engine) closeCandidates(cameraID string, match func(*candidate) bool) ([]Output, error) {
	keys := make([]candKey, 0)
	for k, c := range e.cands {
		if k.camera == cameraID && match(c) {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].subject != keys[j].subject {
			return keys[i].subject < keys[j].subject
		}
		return keys[i].event < keys[j].event
	})
	var out []Output
	for _, k := range keys {
		c := e.cands[k]
		switch {
		case c.incidentID != "":
			if err := e.extend(c, c.lastSeen, true); err != nil {
				return out, err
			}
		case c.rule.Config().InconclusiveOnLoss:
			o, err := e.finalize(e.cameras[cameraID], c.lastSeen, c, StatusInconclusive)
			if err != nil {
				return out, err
			}
			out = append(out, o...)
		}
		delete(e.cands, k)
	}
	return out, nil
}

// stepTamper turns a camera that stays offline or degraded (black, covered,
// frozen) into a camera_tamper incident.
func (e *Engine) stepTamper(cam Camera, st MonitoringState, ts time.Time, h *cameraHealth) ([]Output, error) {
	if e.tamperRule == nil {
		return nil, nil
	}
	bad := st == StateCameraUnavail || st == StateVideoDegraded
	c := e.tamper[cam.ID]
	if !bad {
		if c != nil {
			delete(e.tamper, cam.ID)
			if c.incidentID != "" {
				return nil, e.extend(c, c.lastSeen, true)
			}
		}
		return nil, nil
	}
	detail := "camera offline: no video"
	if st == StateVideoDegraded {
		detail = "video unusable"
		if h.lastQuality.Reason != "" {
			detail += ": " + h.lastQuality.Reason
		}
	}
	if c == nil {
		e.tamper[cam.ID] = &candidate{rule: e.tamperRule, start: ts, lastSeen: ts, roomZone: "camera:" + cam.ID,
			detail: detail, source: h.lastSource, models: h.lastModels}
		return nil, nil
	}
	if ts.After(c.lastSeen) {
		c.lastSeen = ts
	}
	if c.incidentID != "" {
		return nil, e.extend(c, c.lastSeen, false)
	}
	if c.lastSeen.Sub(c.start) < e.tamperRule.Cfg.MinDuration {
		return nil, nil
	}
	return e.finalize(cam, c.lastSeen, c, initialStatus(e.tamperRule.Cfg))
}

func (e *Engine) reportState(cameraID string, st MonitoringState) []Output {
	if e.reported[cameraID] == st {
		return nil
	}
	e.reported[cameraID] = st
	return []Output{{Kind: "state_change", CameraID: cameraID, State: st}}
}

// ---- staff inference ---------------------------------------------------------

type trackKey struct{ camera, track string }

type trackMemory struct {
	staffTime time.Duration
	lastSeen  time.Time
}

// staffAfter is how long a track must spend in staff areas (behind the
// counter, at a post) before it counts as staff.
const staffAfter = 5 * time.Second

// resolveRoles infers each track's role. No face, no identity: only where
// the anonymous track has been (ADR-003).
func (e *Engine) resolveRoles(cam Camera, obs Observation) map[string]Role {
	roles := make(map[string]Role, len(obs.Tracks))
	staffZones := cam.zonesOf(ZoneStaffArea, ZonePost)
	for _, t := range obs.Tracks {
		k := trackKey{cam.ID, t.ID}
		m := e.staff[k]
		if m == nil {
			m = &trackMemory{lastSeen: obs.CaptureTS}
			e.staff[k] = m
		}
		dt := obs.CaptureTS.Sub(m.lastSeen)
		if dt < 0 || dt > time.Second {
			dt = 0 // ignore gaps: a track that reappears gets no free credit
		}
		for _, z := range staffZones {
			if z.Contains(t.FootPoint()) {
				m.staffTime += dt
				break
			}
		}
		m.lastSeen = obs.CaptureTS
		switch {
		case t.Role == RoleStaff || cam.StaffOnly || m.staffTime >= staffAfter:
			roles[t.ID] = RoleStaff
		default:
			roles[t.ID] = t.Role
		}
	}
	return roles
}

// prune drops per-track memory for tracks not seen for a minute, so memory
// stays bounded on a busy floor.
func (e *Engine) prune(cameraID string, now time.Time) {
	const forget = time.Minute
	for k, m := range e.staff {
		if k.camera == cameraID && now.Sub(m.lastSeen) > forget {
			delete(e.staff, k)
		}
	}
	for k, m := range e.lines {
		if k.camera == cameraID && now.Sub(m.seen) > forget {
			delete(e.lines, k)
		}
	}
}
