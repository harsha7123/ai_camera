// Command replay feeds a JSONL observation file (and optionally a JSONL POS
// event file) through the event engine and prints monitoring-state changes,
// incidents, access-log entries and traffic counts as JSON lines. It is the
// offline-replay harness used by tools/eval.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"time"

	"github.com/harsha7123/ai_camera/services/core/internal/eventengine"
)

// config accepts either a bare {"cameras": [...]} file or a full site config
// (services/core/site.example.json): business hours, registers and rule
// overrides are then applied too.
type config struct {
	Cameras       []eventengine.Camera                `json:"cameras"`
	BusinessHours *eventengine.BusinessHoursConfig    `json:"business_hours"`
	Registers     []eventengine.Register              `json:"registers"`
	Rules         map[string]eventengine.RuleOverride `json:"rules"`
}

func main() {
	cfgPath := flag.String("config", "", "site config or camera/zone config JSON")
	obsPath := flag.String("observations", "", "observations JSONL")
	posPath := flag.String("pos", "", "optional POS events JSONL")
	flag.Parse()
	if *cfgPath == "" || *obsPath == "" {
		fmt.Fprintln(os.Stderr, "usage: replay -config site.json -observations obs.jsonl [-pos pos.jsonl]")
		os.Exit(2)
	}
	if err := run(*cfgPath, *obsPath, *posPath, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "replay:", err)
		os.Exit(1)
	}
}

// item is one input in time order: an observation or a POS event.
type item struct {
	at  time.Time
	obs *eventengine.Observation
	pos *eventengine.POSEvent
}

func readLines(path string, each func(line int, raw []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for line := 1; sc.Scan(); line++ {
		if len(sc.Bytes()) == 0 {
			continue
		}
		if err := each(line, sc.Bytes()); err != nil {
			return fmt.Errorf("%s line %d: %w", path, line, err)
		}
	}
	return sc.Err()
}

func run(cfgPath, obsPath, posPath string, w io.Writer) error {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if err := eventengine.ValidateOverrides(cfg.Rules); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	sched, err := eventengine.NewSchedule(cfg.BusinessHours)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	eng := eventengine.NewWithSite(cfg.Cameras, eventengine.DefaultRules(cfg.Rules), eventengine.NewMemoryStore(),
		eventengine.Site{Schedule: sched, Registers: cfg.Registers})

	var items []item
	mock := false
	if err := readLines(obsPath, func(_ int, b []byte) error {
		var o eventengine.Observation
		if err := json.Unmarshal(b, &o); err != nil {
			return err
		}
		mock = mock || o.Source == eventengine.SourceMock
		items = append(items, item{at: o.CaptureTS, obs: &o})
		return nil
	}); err != nil {
		return err
	}
	if posPath != "" {
		if err := readLines(posPath, func(_ int, b []byte) error {
			var ev eventengine.POSEvent
			if err := json.Unmarshal(b, &ev); err != nil {
				return err
			}
			items = append(items, item{at: ev.TS, pos: &ev})
			return nil
		}); err != nil {
			return err
		}
	}
	// Stable: observations of one camera keep their file order.
	sort.SliceStable(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })

	enc := json.NewEncoder(w)
	emit := func(out []eventengine.Output) error {
		for _, ev := range out {
			if err := enc.Encode(ev); err != nil {
				return err
			}
		}
		return nil
	}
	var last time.Time
	for _, it := range items {
		// Advance the clock first, so a gap in a camera's stream is reported
		// as unavailable before it resumes.
		out, err := eng.Tick(it.at)
		if err != nil {
			return err
		}
		if err := emit(out); err != nil {
			return err
		}
		if it.obs != nil {
			out, err = eng.Process(*it.obs)
		} else {
			out, err = eng.ProcessPOS(*it.pos)
		}
		if err != nil {
			return fmt.Errorf("at %s: %w", it.at.Format(time.RFC3339Nano), err)
		}
		if err := emit(out); err != nil {
			return err
		}
		last = it.at
	}
	// Advance the clock past the end of input so silent cameras and pending
	// POS checks are resolved.
	for _, d := range []time.Duration{5 * time.Second} {
		out, err := eng.Tick(last.Add(d))
		if err != nil {
			return err
		}
		if err := emit(out); err != nil {
			return err
		}
	}
	if mock {
		fmt.Fprintln(os.Stderr, "WARNING: input contains MOCK detector observations; incidents are not real detections.")
	}
	return nil
}
