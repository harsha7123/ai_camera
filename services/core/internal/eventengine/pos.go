package eventengine

import (
	"errors"
	"fmt"
	"time"
)

// Register links a POS terminal to the overhead camera that watches it and to
// the zone where a paying customer stands.
type Register struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	CameraID     string `json:"camera_id"`
	CustomerZone string `json:"customer_zone"` // id of a customer_side zone on CameraID
	RoomZone     string `json:"room_zone,omitempty"`
}

func (r Register) roomZone() string {
	if r.RoomZone != "" {
		return r.RoomZone
	}
	return "register:" + r.ID
}

func (r Register) label() string {
	if r.Name != "" {
		return r.Name
	}
	return "register " + r.ID
}

// POSEvent is one transaction-level event from a POS connector. No card data
// is ever accepted (PCI scope minimisation, ADR-010).
type POSEvent struct {
	ID          string    `json:"id"`
	RegisterID  string    `json:"register_id"`
	Type        string    `json:"type"` // sale | no_sale | void | refund | comp | discount
	TS          time.Time `json:"ts"`
	AmountCents *int64    `json:"amount_cents,omitempty"`
	TicketRef   string    `json:"ticket_ref,omitempty"`
	EmployeeRef string    `json:"employee_ref,omitempty"`
}

// ErrUnknownRegister means the event names a register core does not know.
var ErrUnknownRegister = errors.New("pos event for unknown register")

// Validate rejects malformed POS events.
func (ev POSEvent) Validate() error {
	switch {
	case ev.ID == "" || len(ev.ID) > 200:
		return errors.New("pos event: id is required (≤200 chars)")
	case ev.RegisterID == "":
		return errors.New("pos event: register_id is required")
	case ev.TS.IsZero():
		return errors.New("pos event: ts is required")
	case len(ev.TicketRef) > 100 || len(ev.EmployeeRef) > 100:
		return errors.New("pos event: ticket_ref and employee_ref are limited to 100 chars")
	}
	switch ev.Type {
	case "sale", "no_sale", "void", "refund", "comp", "discount":
	default:
		return fmt.Errorf("pos event: unknown type %q", ev.Type)
	}
	return nil
}

func (ev POSEvent) describe(reg Register) string {
	what := map[string]string{"no_sale": "no-sale drawer open", "void": "void", "refund": "refund", "comp": "comp"}[ev.Type]
	if what == "" {
		what = ev.Type
	}
	if ev.AmountCents != nil {
		what += fmt.Sprintf(" $%d.%02d", *ev.AmountCents/100, abs64(*ev.AmountCents%100))
	}
	s := what + " on " + reg.label()
	return s
}

func (ev POSEvent) employeeSuffix() string {
	if ev.EmployeeRef == "" {
		return ""
	}
	return " (POS employee " + ev.EmployeeRef + ")"
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// ---- POS rules ----------------------------------------------------------------

// CameraTamper (G3) is evaluated from camera health, not from frames.
type CameraTamper struct{ Cfg RuleConfig }

func (r *CameraTamper) EventType() string                { return "camera_tamper" }
func (r *CameraTamper) Family() string                   { return "G" }
func (r *CameraTamper) Version() string                  { return "g3-v0.1" }
func (r *CameraTamper) Config() RuleConfig               { return r.Cfg }
func (r *CameraTamper) Evaluate(*FrameContext) []Verdict { return nil }

// POSNoSale (C1): every no-sale drawer open is clipped for review.
type POSNoSale struct{ Cfg RuleConfig }

func (r *POSNoSale) EventType() string                { return "pos_no_sale" }
func (r *POSNoSale) Family() string                   { return "C" }
func (r *POSNoSale) Version() string                  { return "c1-v0.1" }
func (r *POSNoSale) Config() RuleConfig               { return r.Cfg }
func (r *POSNoSale) Evaluate(*FrameContext) []Verdict { return nil }

// POSRefundNoCustomer (C3): a void, refund or comp while nobody was at the
// customer side of the register.
type POSRefundNoCustomer struct {
	Cfg    RuleConfig
	Before time.Duration // look this far before the POS timestamp
	After  time.Duration // and this far after
}

func (r *POSRefundNoCustomer) EventType() string                { return "pos_refund_no_customer" }
func (r *POSRefundNoCustomer) Family() string                   { return "C" }
func (r *POSRefundNoCustomer) Version() string                  { return "c3-v0.1" }
func (r *POSRefundNoCustomer) Config() RuleConfig               { return r.Cfg }
func (r *POSRefundNoCustomer) Evaluate(*FrameContext) []Verdict { return nil }

// presenceKeep is how much customer-presence history is kept per zone. A POS
// event older than this cannot be checked and is recorded INCONCLUSIVE.
const presenceKeep = 10 * time.Minute

type posCheck struct {
	ev  POSEvent
	reg Register
}

// ProcessPOS consumes one POS event. Duplicate ids must be filtered by the
// caller (core stores every event and only forwards new ones); the incident
// idempotency key also makes a duplicate harmless.
func (e *Engine) ProcessPOS(ev POSEvent) ([]Output, error) {
	if err := ev.Validate(); err != nil {
		return nil, err
	}
	reg, ok := e.registers[ev.RegisterID]
	if !ok {
		return nil, ErrUnknownRegister
	}
	cam, ok := e.cameras[reg.CameraID]
	if !ok {
		return nil, fmt.Errorf("register %s: camera %q is not registered", reg.ID, reg.CameraID)
	}
	switch ev.Type {
	case "no_sale":
		if e.noSaleRule == nil {
			return nil, nil
		}
		return e.posIncident(ev, reg, cam, e.noSaleRule, initialStatus(e.noSaleRule.Cfg),
			ev.describe(reg)+ev.employeeSuffix())
	case "void", "refund", "comp":
		if e.refundRule == nil {
			return nil, nil
		}
		e.pending = append(e.pending, &posCheck{ev: ev, reg: reg})
		var camTime time.Time
		if h := e.health[cam.ID]; h != nil {
			camTime = h.lastCapture
		}
		return e.evaluatePOS(cam.ID, camTime)
	}
	return nil, nil // sale, discount: stored by core for reports, no rule yet
}

// evaluatePOS decides pending refund checks on one camera once its clock has
// passed the end of the check window. A check is only decided "nobody there"
// if the camera was analysable for the whole window; otherwise it is
// INCONCLUSIVE.
func (e *Engine) evaluatePOS(cameraID string, camTime time.Time) ([]Output, error) {
	if len(e.pending) == 0 || camTime.IsZero() {
		return nil, nil
	}
	var out []Output
	kept := e.pending[:0]
	var firstErr error
	for i, pc := range e.pending {
		if pc.reg.CameraID != cameraID || firstErr != nil {
			kept = append(kept, pc)
			continue
		}
		winStart, winEnd := pc.ev.TS.Add(-e.refundRule.Before), pc.ev.TS.Add(e.refundRule.After)
		if camTime.Before(winEnd) {
			kept = append(kept, pc) // video has not reached the end of the window yet
			continue
		}
		h := e.health[cameraID]
		covered := h != nil && h.covers(winStart, winEnd) && !winStart.Before(camTime.Add(-presenceKeep))
		if !covered && e.reported[cameraID] == StateOperational && camTime.Before(winEnd.Add(e.staleAfter)) {
			// Tick extrapolates the camera clock; a live camera's next frame
			// will cover the window end, so wait for it.
			kept = append(kept, pc)
			continue
		}
		cam := e.cameras[cameraID]
		var o []Output
		var err error
		switch {
		case !covered:
			o, err = e.posIncident(pc.ev, pc.reg, cam, e.refundRule, StatusInconclusive,
				pc.ev.describe(pc.reg)+": the register camera did not cover that moment"+pc.ev.employeeSuffix())
		case e.present(cameraID, pc.reg.CustomerZone, winStart, winEnd):
			// a customer was there: nothing to review
		default:
			o, err = e.posIncident(pc.ev, pc.reg, cam, e.refundRule, initialStatus(e.refundRule.Cfg),
				pc.ev.describe(pc.reg)+" with nobody seen at the customer side"+pc.ev.employeeSuffix())
		}
		if err != nil {
			firstErr = err
			kept = append(kept, e.pending[i:]...) // retry this one and everything after it
			break
		}
		out = append(out, o...)
	}
	e.pending = kept
	return out, firstErr
}

func (e *Engine) posIncident(ev POSEvent, reg Register, cam Camera, r Rule, status IncidentStatus, detail string) ([]Output, error) {
	idem := idempotencyKey("pos", ev.ID, r.EventType())
	models := map[string]string{"pos_rule": r.Version()}
	if h := e.health[cam.ID]; h != nil {
		for k, v := range h.lastModels {
			models[k] = v
		}
	}
	inc := &Incident{
		ID: "INC-" + idem[:12], IdempotencyKey: idem,
		RoomID: cam.RoomID, RoomZone: reg.roomZone(), EventType: r.EventType(), Family: r.Family(),
		Start: ev.TS, End: ev.TS, Cameras: []string{cam.ID}, Status: status,
		RuleVersion: r.Version(), ModelVersions: models, Source: SourcePOS, Detail: detail, PosRef: ev.TicketRef,
	}
	stored, created, err := e.store.InsertIfAbsent(inc)
	if err != nil || !created {
		return nil, err
	}
	return []Output{{Kind: "incident_created", CameraID: cam.ID, Incident: stored}}, nil
}

// ---- customer presence --------------------------------------------------------

type presenceKey struct{ camera, zone string }

type interval struct{ start, end time.Time }

// presenceGap: two sightings closer than this belong to one presence interval.
const presenceGap = 1500 * time.Millisecond

func (e *Engine) notePresence(cam Camera, zoneID string, ts time.Time) {
	k := presenceKey{cam.ID, zoneID}
	iv := e.presence[k]
	if n := len(iv); n > 0 && ts.Sub(iv[n-1].end) <= presenceGap {
		if ts.After(iv[n-1].end) {
			iv[n-1].end = ts
		}
	} else {
		iv = append(iv, interval{ts, ts})
	}
	// drop history older than presenceKeep
	cut := 0
	for cut < len(iv) && ts.Sub(iv[cut].end) > presenceKeep {
		cut++
	}
	e.presence[k] = iv[cut:]
}

func (e *Engine) present(cameraID, zoneID string, from, to time.Time) bool {
	for _, iv := range e.presence[presenceKey{cameraID, zoneID}] {
		if !iv.start.After(to) && !iv.end.Before(from) {
			return true
		}
	}
	return false
}
