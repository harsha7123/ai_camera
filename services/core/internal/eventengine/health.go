package eventengine

import "time"

// MonitoringState is what the dashboard shows for a camera. Only
// StateOperational may be rendered as green.
type MonitoringState string

const (
	StateOperational    MonitoringState = "FULLY_OPERATIONAL"
	StateCameraUnavail  MonitoringState = "CAMERA_UNAVAILABLE"
	StateVideoDegraded  MonitoringState = "VIDEO_DEGRADED"
	StateAIUnavailable  MonitoringState = "AI_UNAVAILABLE"
	StateNeverConnected MonitoringState = "NOT_CONNECTED"
	defaultStaleAfter                   = 3 * time.Second
)

// Analyzable reports whether rules may run on this camera.
func (s MonitoringState) Analyzable() bool { return s == StateOperational }

type cameraHealth struct {
	lastRecv    time.Time  // wall clock, when core received the last observation
	lastCapture time.Time  // camera clock, capture_ts of the last observation
	coverage    []interval // camera clock: when this camera was analysable (recent history)
	lastQuality Quality
	aiAvailable bool
	lastSource  string
	lastModels  map[string]string
}

// coverageGap: analysable frames closer than this form one coverage interval.
const coverageGap = 2 * time.Second

// noteCoverage records that the camera was analysable at ts.
func (h *cameraHealth) noteCoverage(ts time.Time) {
	if n := len(h.coverage); n > 0 && ts.Sub(h.coverage[n-1].end) <= coverageGap {
		if ts.After(h.coverage[n-1].end) {
			h.coverage[n-1].end = ts
		}
	} else {
		h.coverage = append(h.coverage, interval{ts, ts})
	}
	cut := 0
	for cut < len(h.coverage) && ts.Sub(h.coverage[cut].end) > presenceKeep {
		cut++
	}
	h.coverage = h.coverage[cut:]
}

// covers reports whether the camera was analysable throughout [from, to].
func (h *cameraHealth) covers(from, to time.Time) bool {
	for _, iv := range h.coverage {
		if !iv.start.After(from) && !iv.end.Before(to) {
			return true
		}
	}
	return false
}

// stateAt derives the monitoring state at wall-clock time now. A camera whose
// last observation arrived more than staleAfter ago is unavailable even if
// that observation looked healthy: a frozen pipeline must never look green.
func (h *cameraHealth) stateAt(now time.Time, staleAfter time.Duration) MonitoringState {
	switch {
	case h.lastRecv.IsZero():
		return StateNeverConnected
	case now.Sub(h.lastRecv) > staleAfter:
		return StateCameraUnavail
	case !h.aiAvailable:
		return StateAIUnavailable
	case h.lastQuality.Degraded:
		return StateVideoDegraded
	default:
		return StateOperational
	}
}
