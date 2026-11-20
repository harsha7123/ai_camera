// Package eventengine turns detector observations and POS events into
// monitoring states, incidents, access-log entries and traffic counts.
// Detectors only report what they saw. Every decision is made here, by
// explicit, versioned, per-event rules (ADR-002). An incident is a prompt for
// a manager to review a clip, never a finding about a person.
package eventengine

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// Role of a tracked person. Video never identifies anyone (ADR-003): the
// worker reports "person", and the engine infers "staff" from where a track
// spends its time (staff_area zones) or from a staff_only camera.
type Role string

const (
	RolePerson   Role = "person"   // unknown: customer, delivery driver, staff not yet recognised
	RoleStaff    Role = "staff"    // staff_area dwell, staff_only camera, or an opt-in uniform classifier
	RoleCustomer Role = "customer" // reserved for an opt-in classifier; treated like person
)

// Track is one tracked person in one frame. Box is normalized [x1, y1, x2, y2]
// with y growing downwards, matching image coordinates.
type Track struct {
	ID          string     `json:"id"`
	Role        Role       `json:"role"`
	Score       float64    `json:"score"`
	Box         [4]float64 `json:"box"`
	PoseQuality float64    `json:"pose_quality"`
	Visibility  float64    `json:"visibility"`
}

// FootPoint is the bottom-centre of the box, used for zone membership.
func (t Track) FootPoint() Point {
	return Point{X: (t.Box[0] + t.Box[2]) / 2, Y: t.Box[3]}
}

// Center is the centre of the box.
func (t Track) Center() Point {
	return Point{X: (t.Box[0] + t.Box[2]) / 2, Y: (t.Box[1] + t.Box[3]) / 2}
}

// Quality describes whether the frame is fit for analysis.
type Quality struct {
	Degraded bool   `json:"degraded"`
	Reason   string `json:"reason,omitempty"`
}

// Observation is the contract between the vision worker and core. It mirrors
// packages/contracts/observation.schema.json.
type Observation struct {
	CameraID      string            `json:"camera_id"`
	CaptureTS     time.Time         `json:"capture_ts"`
	TSSource      string            `json:"ts_source,omitempty"` // rtcp | receive
	Source        string            `json:"source"`
	ModelVersions map[string]string `json:"model_versions"`
	Quality       Quality           `json:"quality"`
	AIAvailable   bool              `json:"ai_available"`
	FrameSize     [2]int            `json:"frame_size,omitempty"` // analysed frame [width, height] in pixels
	Tracks        []Track           `json:"tracks"`

	// ReceivedAt is when core received the observation (wall clock). It is
	// set by the ingest handler, never decoded from JSON. Staleness is
	// measured on this clock, so camera clock skew or pipeline latency cannot
	// make a live camera look dead or a dead one look live. Zero (offline
	// replay) means "same as CaptureTS".
	ReceivedAt time.Time `json:"-"`
}

// SourceMock marks observations produced by a mock detector. Incidents derived
// from them carry the same marker so they can never be mistaken for real
// detections.
const SourceMock = "MOCK"

// SourcePOS marks incidents that came from a POS event.
const SourcePOS = "POS"

func (o Observation) received() time.Time {
	if o.ReceivedAt.IsZero() {
		return o.CaptureTS
	}
	return o.ReceivedAt
}

// aspect is the width/height ratio of the analysed frame (16:9 if unknown).
func (o Observation) aspect() float64 {
	if o.FrameSize[0] > 0 && o.FrameSize[1] > 0 {
		return float64(o.FrameSize[0]) / float64(o.FrameSize[1])
	}
	return 16.0 / 9.0
}

// Validate rejects malformed observations before they reach any rule.
func (o Observation) Validate() error {
	if o.CameraID == "" {
		return errors.New("observation: camera_id is required")
	}
	if o.CaptureTS.IsZero() {
		return errors.New("observation: capture_ts is required")
	}
	if o.Source == "" {
		return errors.New("observation: source is required")
	}
	if o.FrameSize[0] < 0 || o.FrameSize[1] < 0 {
		return errors.New("observation: frame_size must be positive")
	}
	for _, t := range o.Tracks {
		if t.ID == "" {
			return errors.New("observation: track id is required")
		}
		switch t.Role {
		case RolePerson, RoleStaff, RoleCustomer:
		default:
			return fmt.Errorf("observation: track %s has unknown role %q", t.ID, t.Role)
		}
		for _, v := range []float64{t.Score, t.PoseQuality, t.Visibility, t.Box[0], t.Box[1], t.Box[2], t.Box[3]} {
			if math.IsNaN(v) || v < 0 || v > 1 {
				return fmt.Errorf("observation: track %s has value outside [0,1]", t.ID)
			}
		}
		if t.Box[2] < t.Box[0] || t.Box[3] < t.Box[1] {
			return fmt.Errorf("observation: track %s has inverted box", t.ID)
		}
	}
	return nil
}

// Point is a normalized image coordinate.
type Point struct{ X, Y float64 }

// ZoneKind says how rules interpret a zone.
type ZoneKind string

const (
	// ZoneRestricted: customers should not be here (office, kitchen door).
	ZoneRestricted ZoneKind = "restricted"
	// ZoneSecure: cash office, safe, walk-in cooler, back door. Every visit
	// goes to the access log; a visit by someone not recognised as staff is
	// also a restricted_zone_entry.
	ZoneSecure ZoneKind = "secure"
	// ZoneStaffArea: behind the counter, the line. Time spent here marks a
	// track as staff.
	ZoneStaffArea ZoneKind = "staff_area"
	// ZoneQueue: where customers line up (long_queue, long_wait).
	ZoneQueue ZoneKind = "queue"
	// ZonePost: a position that must be staffed while open (register, host
	// stand). Also counts as a staff area.
	ZonePost ZoneKind = "post"
	// ZoneCustomerSide: in front of a register; used by POS rules.
	ZoneCustomerSide ZoneKind = "customer_side"
	// ZoneFloor: where a person lying down means someone fell (person_down).
	ZoneFloor ZoneKind = "floor"
	// ZoneCountLine: a 2-point line A→B. Crossing from its left side to its
	// right side (with A left of B on screen: moving down the screen) is an
	// entry, the other way an exit.
	ZoneCountLine ZoneKind = "count_line"
)

// ValidZoneKind reports whether k is a known zone kind.
func ValidZoneKind(k ZoneKind) bool {
	switch k {
	case ZoneRestricted, ZoneSecure, ZoneStaffArea, ZoneQueue, ZonePost, ZoneCustomerSide, ZoneFloor, ZoneCountLine:
		return true
	}
	return false
}

// Zone is a polygon (or, for count_line, a line) drawn on one camera's
// calibration snapshot. RoomZone is the area-level identifier shared by every
// camera that sees the same place, which is what lets the engine merge one
// event seen by several cameras.
type Zone struct {
	ID       string   `json:"id"`
	RoomZone string   `json:"room_zone"`
	Kind     ZoneKind `json:"kind"`
	Polygon  []Point  `json:"polygon"`
}

// Contains reports whether p lies inside the polygon (ray casting).
func (z Zone) Contains(p Point) bool {
	in := false
	n := len(z.Polygon)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		a, b := z.Polygon[i], z.Polygon[j]
		if (a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X-a.X)*(p.Y-a.Y)/(b.Y-a.Y)+a.X {
			in = !in
		}
	}
	return in
}

// side returns which side of a count line p is on: >0 right of A→B, <0 left.
func (z Zone) side(p Point) float64 {
	if len(z.Polygon) != 2 {
		return 0
	}
	a, b := z.Polygon[0], z.Polygon[1]
	return (b.X-a.X)*(p.Y-a.Y) - (b.Y-a.Y)*(p.X-a.X)
}

// within reports whether p projects onto the segment A→B (so walking past the
// end of a door line does not count).
func (z Zone) within(p Point) bool {
	if len(z.Polygon) != 2 {
		return false
	}
	a, b := z.Polygon[0], z.Polygon[1]
	dx, dy := b.X-a.X, b.Y-a.Y
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return false
	}
	t := ((p.X-a.X)*dx + (p.Y-a.Y)*dy) / l2
	return t >= 0 && t <= 1
}

// Camera is the per-camera configuration the engine needs.
type Camera struct {
	ID        string `json:"id"`
	RoomID    string `json:"room_id"`
	StaffOnly bool   `json:"staff_only,omitempty"` // kitchen / back of house: everyone seen is staff
	Zones     []Zone `json:"zones"`
}

func (c Camera) zonesOf(kinds ...ZoneKind) []Zone {
	var out []Zone
	for _, z := range c.Zones {
		for _, k := range kinds {
			if z.Kind == k {
				out = append(out, z)
				break
			}
		}
	}
	return out
}
