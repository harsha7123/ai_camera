package eventengine

import (
	"math"
	"time"
)

// ZoneAccess is one visit by one anonymous track to a secure zone (safe,
// cash office, walk-in cooler, back door). It answers "who went in, when,
// for how long" without identifying anyone: Role is staff or person.
type ZoneAccess struct {
	CameraID   string    `json:"camera_id"`
	RoomID     string    `json:"room_id"`
	RoomZone   string    `json:"room_zone"`
	ZoneID     string    `json:"zone_id"`
	Role       Role      `json:"role"`
	Start      time.Time `json:"start"`
	End        time.Time `json:"end"`
	AfterHours bool      `json:"after_hours"`
}

// TrafficDelta is an increment to one camera's 15-minute traffic bucket.
type TrafficDelta struct {
	CameraID      string    `json:"camera_id"`
	Bucket        time.Time `json:"bucket"`
	Entries       int       `json:"entries"`
	Exits         int       `json:"exits"`
	PeakOccupancy int       `json:"peak_occupancy"`
}

// TrafficBucket is the traffic bucket width.
const TrafficBucket = 15 * time.Minute

type visitKey struct{ camera, track, zone string }

type visit struct {
	zone     Zone
	start    time.Time
	lastSeen time.Time
	staff    bool
}

type lineMemory struct {
	side float64
	seen time.Time
}

type bucketPeak struct {
	bucket time.Time
	peak   int
}

// visitEndAfter: a visit ends once its track has been out of the zone (or out
// of view) this long.
const visitEndAfter = 2 * time.Second

// lineDeadband ignores foot points this close to a count line, so jitter on
// the line is not counted as crossings.
const lineDeadband = 0.0005

// analytics updates the access log, traffic counts and customer presence for
// one analysable frame.
func (e *Engine) analytics(fc *FrameContext) []Output {
	cam, obs, ts := fc.Cam, fc.Obs, fc.Obs.CaptureTS
	var out []Output

	// Secure-zone visits.
	for _, z := range cam.zonesOf(ZoneSecure) {
		for _, t := range obs.Tracks {
			if !z.Contains(t.FootPoint()) {
				continue
			}
			k := visitKey{cam.ID, t.ID, z.ID}
			v := e.visits[k]
			if v == nil {
				v = &visit{zone: z, start: ts}
				e.visits[k] = v
			}
			v.lastSeen = ts
			v.staff = v.staff || fc.Roles[t.ID] == RoleStaff
		}
	}
	out = append(out, e.closeVisits(cam.ID, ts, false)...)

	// Foot traffic: count-line crossings.
	for _, z := range cam.zonesOf(ZoneCountLine) {
		for _, t := range obs.Tracks {
			fp := t.FootPoint()
			s := z.side(fp)
			if math.Abs(s) < lineDeadband {
				continue
			}
			k := visitKey{cam.ID, t.ID, z.ID}
			m := e.lines[k]
			if m == nil {
				e.lines[k] = &lineMemory{side: s, seen: ts}
				continue
			}
			prev := m.side
			m.side, m.seen = s, ts
			if !z.within(fp) {
				continue
			}
			switch {
			case prev < 0 && s > 0:
				out = append(out, Output{Kind: "traffic", CameraID: cam.ID,
					Traffic: &TrafficDelta{CameraID: cam.ID, Bucket: ts.UTC().Truncate(TrafficBucket), Entries: 1}})
			case prev > 0 && s < 0:
				out = append(out, Output{Kind: "traffic", CameraID: cam.ID,
					Traffic: &TrafficDelta{CameraID: cam.ID, Bucket: ts.UTC().Truncate(TrafficBucket), Exits: 1}})
			}
		}
	}

	// Peak occupancy per bucket: emitted only when the peak grows.
	b := ts.UTC().Truncate(TrafficBucket)
	bp := e.traffic[cam.ID]
	if bp == nil || !bp.bucket.Equal(b) {
		bp = &bucketPeak{bucket: b}
		e.traffic[cam.ID] = bp
	}
	if n := len(obs.Tracks); n > bp.peak {
		bp.peak = n
		out = append(out, Output{Kind: "traffic", CameraID: cam.ID,
			Traffic: &TrafficDelta{CameraID: cam.ID, Bucket: b, PeakOccupancy: n}})
	}

	// Customer presence at registers (for POS rules).
	for _, z := range cam.zonesOf(ZoneCustomerSide) {
		for _, t := range obs.Tracks {
			if fc.Roles[t.ID] != RoleStaff && z.Contains(t.FootPoint()) {
				e.notePresence(cam, z.ID, ts)
				break
			}
		}
	}
	return out
}

// closeVisits ends visits on a camera whose track left; all of them if the
// camera stopped being analysable.
func (e *Engine) closeVisits(cameraID string, now time.Time, all bool) []Output {
	var out []Output
	cam := e.cameras[cameraID]
	for k, v := range e.visits {
		if k.camera != cameraID || (!all && now.Sub(v.lastSeen) <= visitEndAfter) {
			continue
		}
		delete(e.visits, k)
		if !v.lastSeen.After(v.start) {
			continue // a single-frame blip is not a visit
		}
		role := RolePerson
		if v.staff {
			role = RoleStaff
		}
		out = append(out, Output{Kind: "zone_access", CameraID: cameraID, Access: &ZoneAccess{
			CameraID: cameraID, RoomID: cam.RoomID, RoomZone: v.zone.RoomZone, ZoneID: v.zone.ID, Role: role,
			Start: v.start, End: v.lastSeen, AfterHours: !e.schedule.InStaffWindow(v.start),
		}})
	}
	return out
}
