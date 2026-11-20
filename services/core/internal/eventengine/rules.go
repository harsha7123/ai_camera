package eventengine

import (
	"fmt"
	"time"
)

// Policy says what a confirmed incident of this rule may do.
type Policy string

const (
	PolicyReview Policy = "review"
	PolicyAlert  Policy = "alert"
)

// RuleConfig holds the per-event thresholds. Each event type has its own; there
// is deliberately no global risk score.
type RuleConfig struct {
	MinDuration time.Duration // trigger must persist this long
	MergeGap    time.Duration // windows closer than this in the same room zone merge
	Policy      Policy
	// AlertingEnabled lets an alert-policy rule page staff. Until the site
	// owner enables it after a tuning period (ADR-008), alert-policy
	// incidents are SHADOW: recorded and visible to owners, nobody is paged.
	AlertingEnabled bool
	// InconclusiveOnLoss: if the subject disappears (or the camera degrades)
	// before MinDuration, record an INCONCLUSIVE incident instead of
	// discarding the candidate. True for security and safety rules, where
	// "we lost sight of them" must not become "nothing happened"; false for
	// operational dwell rules, where track switches at a busy counter would
	// otherwise flood the inbox.
	InconclusiveOnLoss bool
}

// FrameContext is everything a rule may read about one analysed frame.
type FrameContext struct {
	Cam         Camera
	Obs         Observation
	Roles       map[string]Role // track id → resolved role (staff inference applied)
	Open        bool            // within business hours
	StaffWindow bool            // within business hours ± staff allowances
}

// Verdict is one rule's reading of one subject (a track, or a zone for zone
// rules) in one frame.
type Verdict struct {
	Subject    string
	Trigger    bool
	EvidenceOK bool
	RoomZone   string
	Detail     string
}

// Rule evaluates a single event type. Rules are pure functions of the frame.
// A zone rule must return a verdict for each of its zones on every frame
// (Trigger=false when quiet), so its candidates end when the condition ends.
type Rule interface {
	EventType() string
	Family() string
	Version() string
	Config() RuleConfig
	Evaluate(fc *FrameContext) []Verdict
}

func trackSubject(t Track) string { return "track:" + t.ID }
func zoneSubject(z Zone) string   { return "zone:" + z.ID }

// ---- G1 after-hours intrusion ----------------------------------------------

// AfterHoursIntrusion fires for any person seen outside the staff window.
type AfterHoursIntrusion struct {
	Cfg      RuleConfig
	MinScore float64
}

func (r *AfterHoursIntrusion) EventType() string  { return "after_hours_intrusion" }
func (r *AfterHoursIntrusion) Family() string     { return "G" }
func (r *AfterHoursIntrusion) Version() string    { return "g1-v0.1" }
func (r *AfterHoursIntrusion) Config() RuleConfig { return r.Cfg }

func (r *AfterHoursIntrusion) Evaluate(fc *FrameContext) []Verdict {
	out := make([]Verdict, 0, len(fc.Obs.Tracks))
	for _, t := range fc.Obs.Tracks {
		v := Verdict{Subject: trackSubject(t), EvidenceOK: true}
		if !fc.StaffWindow {
			v = Verdict{Subject: trackSubject(t), Trigger: true, EvidenceOK: t.Score >= r.MinScore,
				RoomZone: "room:" + fc.Cam.RoomID, Detail: "person on camera outside business hours"}
		}
		out = append(out, v)
	}
	return out
}

// ---- D5/G4 restricted or secure zone entered by someone not known as staff --

type RestrictedZoneEntry struct {
	Cfg      RuleConfig
	MinScore float64
}

func (r *RestrictedZoneEntry) EventType() string  { return "restricted_zone_entry" }
func (r *RestrictedZoneEntry) Family() string     { return "D" }
func (r *RestrictedZoneEntry) Version() string    { return "d5-v0.1" }
func (r *RestrictedZoneEntry) Config() RuleConfig { return r.Cfg }

func (r *RestrictedZoneEntry) Evaluate(fc *FrameContext) []Verdict {
	out := make([]Verdict, 0, len(fc.Obs.Tracks))
	zones := fc.Cam.zonesOf(ZoneRestricted, ZoneSecure)
	for _, t := range fc.Obs.Tracks {
		v := Verdict{Subject: trackSubject(t), EvidenceOK: true}
		// After hours everyone is an intrusion; this rule covers open hours.
		if fc.StaffWindow && fc.Roles[t.ID] != RoleStaff {
			for _, z := range zones {
				if z.Contains(t.FootPoint()) {
					v = Verdict{Subject: trackSubject(t), Trigger: true, EvidenceOK: t.Score >= r.MinScore,
						RoomZone: z.RoomZone, Detail: fmt.Sprintf("person not recognised as staff in %s zone %s", z.Kind, z.ID)}
					break
				}
			}
		}
		out = append(out, v)
	}
	return out
}

// ---- F6 person down (slip / trip / fall) -----------------------------------

// PersonDown fires when a person's box stays lying-down shaped inside a floor
// zone. Only cameras with a floor zone are evaluated: an overhead or fisheye
// camera sees standing people as wide boxes, so it must not be used.
// This is a heuristic (someone sitting or crouching on the floor also
// triggers it); it ships in SHADOW until tuned on site footage.
type PersonDown struct {
	Cfg       RuleConfig
	MinScore  float64
	MinAspect float64 // real width / real height
}

func (r *PersonDown) EventType() string  { return "person_down" }
func (r *PersonDown) Family() string     { return "F" }
func (r *PersonDown) Version() string    { return "f6-v0.1" }
func (r *PersonDown) Config() RuleConfig { return r.Cfg }

func (r *PersonDown) Evaluate(fc *FrameContext) []Verdict {
	floors := fc.Cam.zonesOf(ZoneFloor)
	if len(floors) == 0 {
		return nil
	}
	out := make([]Verdict, 0, len(fc.Obs.Tracks))
	ar := fc.Obs.aspect()
	for _, t := range fc.Obs.Tracks {
		v := Verdict{Subject: trackSubject(t), EvidenceOK: true}
		w, h := t.Box[2]-t.Box[0], t.Box[3]-t.Box[1]
		if h > 0 && (w*ar)/h >= r.MinAspect {
			for _, z := range floors {
				if z.Contains(t.Center()) {
					v = Verdict{Subject: trackSubject(t), Trigger: true, EvidenceOK: t.Score >= r.MinScore,
						RoomZone: z.RoomZone, Detail: "person appears to be lying on the floor in " + z.ID}
					break
				}
			}
		}
		out = append(out, v)
	}
	return out
}

// ---- A4 long queue (zone rule) ---------------------------------------------

type LongQueue struct {
	Cfg       RuleConfig
	MaxPeople int
}

func (r *LongQueue) EventType() string  { return "long_queue" }
func (r *LongQueue) Family() string     { return "A" }
func (r *LongQueue) Version() string    { return "a4q-v0.1" }
func (r *LongQueue) Config() RuleConfig { return r.Cfg }

func (r *LongQueue) Evaluate(fc *FrameContext) []Verdict {
	var out []Verdict
	for _, z := range fc.Cam.zonesOf(ZoneQueue) {
		n := 0
		for _, t := range fc.Obs.Tracks {
			if fc.Roles[t.ID] != RoleStaff && z.Contains(t.FootPoint()) {
				n++
			}
		}
		out = append(out, Verdict{Subject: zoneSubject(z), Trigger: fc.Open && n >= r.MaxPeople, EvidenceOK: true,
			RoomZone: z.RoomZone, Detail: fmt.Sprintf("%d or more people waiting in %s", r.MaxPeople, z.ID)})
	}
	return out
}

// ---- A4 long wait (per person) ---------------------------------------------

type LongWait struct{ Cfg RuleConfig }

func (r *LongWait) EventType() string  { return "long_wait" }
func (r *LongWait) Family() string     { return "A" }
func (r *LongWait) Version() string    { return "a4w-v0.1" }
func (r *LongWait) Config() RuleConfig { return r.Cfg }

func (r *LongWait) Evaluate(fc *FrameContext) []Verdict {
	queues := fc.Cam.zonesOf(ZoneQueue)
	if len(queues) == 0 {
		return nil
	}
	out := make([]Verdict, 0, len(fc.Obs.Tracks))
	for _, t := range fc.Obs.Tracks {
		v := Verdict{Subject: trackSubject(t), EvidenceOK: true}
		if fc.Open && fc.Roles[t.ID] != RoleStaff {
			for _, z := range queues {
				if z.Contains(t.FootPoint()) {
					v = Verdict{Subject: trackSubject(t), Trigger: true, EvidenceOK: true, RoomZone: z.RoomZone,
						Detail: fmt.Sprintf("a person has waited %s or more in %s", r.Cfg.MinDuration, z.ID)}
					break
				}
			}
		}
		out = append(out, v)
	}
	return out
}

// ---- B4 unattended post (zone rule) ----------------------------------------

type UnattendedPost struct{ Cfg RuleConfig }

func (r *UnattendedPost) EventType() string  { return "unattended_post" }
func (r *UnattendedPost) Family() string     { return "B" }
func (r *UnattendedPost) Version() string    { return "b4-v0.1" }
func (r *UnattendedPost) Config() RuleConfig { return r.Cfg }

func (r *UnattendedPost) Evaluate(fc *FrameContext) []Verdict {
	var out []Verdict
	for _, z := range fc.Cam.zonesOf(ZonePost) {
		empty := true
		for _, t := range fc.Obs.Tracks {
			if z.Contains(t.FootPoint()) {
				empty = false
				break
			}
		}
		out = append(out, Verdict{Subject: zoneSubject(z), Trigger: fc.Open && empty, EvidenceOK: true,
			RoomZone: z.RoomZone, Detail: fmt.Sprintf("nobody at %s for %s or more during business hours", z.ID, r.Cfg.MinDuration)})
	}
	return out
}
