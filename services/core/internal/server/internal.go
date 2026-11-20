package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/harsha7123/ai_camera/services/core/internal/eventengine"
)

// maxObservationLine bounds one NDJSON line.
const maxObservationLine = 1 << 20

// maxFutureSkew: observations stamped further than this in the future are
// ignored (a camera with a wrong clock must not keep itself "live").
const maxFutureSkew = 30 * time.Second

// InternalHandler serves the localhost-only API that vision-worker and POS
// connectors talk to.
func (s *Server) InternalHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/v1/observations", s.ingest)
	mux.HandleFunc("POST /internal/v1/pos-events", s.ingestPOS)
	mux.HandleFunc("GET /internal/v1/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !bearerOK(r, s.Cfg.InternalToken) {
			writeErr(w, http.StatusUnauthorized, "missing or wrong bearer token")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// ndjsonReply tracks progress through an NDJSON stream so the response tells
// the sender exactly which line to resume from: lines before `line` were
// either queued (accepted) or deliberately ignored, and must not be resent.
type ndjsonReply struct {
	w        http.ResponseWriter
	accepted int
	ignored  int
	index    int // 0-based index of the current non-empty line
}

func (n *ndjsonReply) send(status int, msg string) {
	body := map[string]any{"accepted": n.accepted, "ignored": n.ignored}
	if msg != "" {
		body["error"] = msg
		body["line"] = n.index
	}
	writeJSON(n.w, status, body)
}

// decodeStrict decodes exactly one JSON object with no unknown fields.
func decodeStrict(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields() // the schemas forbid additional properties
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data after the object")
	}
	return nil
}

// enqueue waits up to IngestTimeout for space in the engine queue.
func enqueue[T any](ctx context.Context, ch chan T, v T, timeout time.Duration) (ok bool, cancelled bool) {
	select {
	case ch <- v:
		return true, false
	default:
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ch <- v:
		return true, false
	case <-timer.C:
		return false, false
	case <-ctx.Done():
		return false, true
	}
}

// ingest reads a stream of NDJSON observations and queues each for the
// engine, in order. The first bad line stops the stream with 400; a full
// engine queue stops it with 503, so the worker backs off instead of core
// silently dropping frames.
func (s *Server) ingest(w http.ResponseWriter, r *http.Request) {
	sc := bufio.NewScanner(r.Body)
	sc.Buffer(make([]byte, 64<<10), maxObservationLine)
	rep := &ndjsonReply{w: w}
	unknown := map[string]bool{}
	skewed := 0
	defer func() {
		if len(unknown) > 0 {
			s.Log.Warn("observations for unregistered cameras ignored", "cameras", keys(unknown))
		}
		if skewed > 0 {
			s.Log.Warn("observations with capture_ts too far in the future ignored; check camera/worker clocks", "count", skewed)
		}
	}()
	for ; sc.Scan(); rep.index++ {
		raw := bytes.TrimSpace(sc.Bytes())
		if len(raw) == 0 {
			rep.index--
			continue
		}
		var o eventengine.Observation
		if err := decodeStrict(raw, &o); err != nil {
			rep.send(http.StatusBadRequest, fmt.Sprintf("line %d: %v", rep.index, err))
			return
		}
		if err := o.Validate(); err != nil {
			rep.send(http.StatusBadRequest, fmt.Sprintf("line %d: %v", rep.index, err))
			return
		}
		now := time.Now()
		if !s.knownCamera(o.CameraID) {
			rep.ignored++
			unknown[o.CameraID] = true
			continue
		}
		if o.CaptureTS.After(now.Add(maxFutureSkew)) {
			rep.ignored++
			skewed++
			continue
		}
		o.ReceivedAt = now
		ok, cancelled := enqueue(r.Context(), s.obsCh, o, s.Cfg.IngestTimeout)
		if cancelled {
			return
		}
		if !ok {
			rep.send(http.StatusServiceUnavailable, "engine backlog full")
			return
		}
		rep.accepted++
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			rep.send(http.StatusBadRequest, "observation line too long")
			return
		}
		rep.send(http.StatusBadRequest, "reading body: "+err.Error())
		return
	}
	rep.send(http.StatusOK, "")
}

// ingestPOS reads NDJSON POS events. Each new event is stored (pos_events)
// and then handed to the engine; events whose id was already received, or
// whose register is unknown, are ignored.
func (s *Server) ingestPOS(w http.ResponseWriter, r *http.Request) {
	sc := bufio.NewScanner(r.Body)
	sc.Buffer(make([]byte, 16<<10), 64<<10)
	rep := &ndjsonReply{w: w}
	for ; sc.Scan(); rep.index++ {
		raw := bytes.TrimSpace(sc.Bytes())
		if len(raw) == 0 {
			rep.index--
			continue
		}
		var ev eventengine.POSEvent
		if err := decodeStrict(raw, &ev); err != nil {
			rep.send(http.StatusBadRequest, fmt.Sprintf("line %d: %v", rep.index, err))
			return
		}
		if err := ev.Validate(); err != nil {
			rep.send(http.StatusBadRequest, fmt.Sprintf("line %d: %v", rep.index, err))
			return
		}
		if !s.knownRegister(ev.RegisterID) {
			rep.ignored++
			s.Log.Warn("pos event for unknown register ignored", "register", ev.RegisterID)
			continue
		}
		fresh, err := s.DB.InsertPOSEvent(r.Context(), ev)
		if err != nil {
			s.Log.Error("store pos event", "err", err)
			rep.send(http.StatusServiceUnavailable, "cannot store pos event")
			return
		}
		if !fresh {
			rep.ignored++ // duplicate id: already processed
			continue
		}
		ok, cancelled := enqueue(r.Context(), s.posCh, ev, s.Cfg.IngestTimeout)
		if cancelled {
			return
		}
		if !ok {
			// Stored but not processed. Remove the row so the sender's retry
			// is not mistaken for a duplicate, then report the backlog.
			if err := s.DB.DeletePOSEvent(context.Background(), ev.ID); err != nil {
				s.Log.Error("undo pos event after backlog", "id", ev.ID, "err", err)
			}
			rep.send(http.StatusServiceUnavailable, "engine backlog full")
			return
		}
		rep.accepted++
	}
	if err := sc.Err(); err != nil {
		rep.send(http.StatusBadRequest, "reading body: "+err.Error())
		return
	}
	rep.send(http.StatusOK, "")
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
