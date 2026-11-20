package eventengine

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// BusinessHoursConfig is the site-config form of the opening hours.
type BusinessHoursConfig struct {
	Timezone        string                 `json:"timezone"`
	Weekly          map[string][][2]string `json:"weekly"` // "mon".."sun" → [["11:00","22:00"], ...]
	StaffBeforeOpen string                 `json:"staff_before_open,omitempty"`
	StaffAfterClose string                 `json:"staff_after_close,omitempty"`
}

type span struct{ open, close int } // minutes after local midnight; close <= open crosses midnight

// Schedule answers "is the restaurant open?" and "may staff be here?" in the
// site's own timezone. A nil Schedule means no hours are configured: the site
// counts as always open, and the after-hours rule never fires.
type Schedule struct {
	loc         *time.Location
	weekly      [7][]span
	staffBefore time.Duration
	staffAfter  time.Duration
}

var dayNames = map[string]time.Weekday{
	"sun": time.Sunday, "mon": time.Monday, "tue": time.Tuesday, "wed": time.Wednesday,
	"thu": time.Thursday, "fri": time.Friday, "sat": time.Saturday,
}

// NewSchedule validates and compiles business hours. A nil config returns nil.
func NewSchedule(c *BusinessHoursConfig) (*Schedule, error) {
	if c == nil {
		return nil, nil
	}
	if c.Timezone == "" {
		return nil, errors.New("business_hours: timezone is required (IANA name, e.g. America/New_York)")
	}
	loc, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return nil, fmt.Errorf("business_hours: %w", err)
	}
	s := &Schedule{loc: loc}
	for name, spans := range c.Weekly {
		wd, ok := dayNames[strings.ToLower(name)]
		if !ok {
			return nil, fmt.Errorf("business_hours: unknown day %q (use mon..sun)", name)
		}
		for _, sp := range spans {
			o, err1 := parseHHMM(sp[0])
			cl, err2 := parseHHMM(sp[1])
			if err1 != nil || err2 != nil {
				return nil, fmt.Errorf("business_hours: %s: bad time in %v (use HH:MM)", name, sp)
			}
			if o == cl {
				return nil, fmt.Errorf("business_hours: %s: open and close are equal", name)
			}
			s.weekly[wd] = append(s.weekly[wd], span{o, cl})
		}
	}
	for _, p := range []struct {
		in  string
		out *time.Duration
	}{{c.StaffBeforeOpen, &s.staffBefore}, {c.StaffAfterClose, &s.staffAfter}} {
		if p.in == "" {
			continue
		}
		d, err := time.ParseDuration(p.in)
		if err != nil || d < 0 || d > 12*time.Hour {
			return nil, fmt.Errorf("business_hours: bad staff allowance %q", p.in)
		}
		*p.out = d
	}
	return s, nil
}

func parseHHMM(s string) (int, error) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		if s == "24:00" {
			return 24 * 60, nil
		}
		return 0, err
	}
	return t.Hour()*60 + t.Minute(), nil
}

// Location returns the site timezone (UTC if no schedule).
func (s *Schedule) Location() *time.Location {
	if s == nil {
		return time.UTC
	}
	return s.loc
}

// intervals yields the absolute open intervals that could contain t, widened
// by before and after.
func (s *Schedule) contains(t time.Time, before, after time.Duration) bool {
	lt := t.In(s.loc)
	y, m, d := lt.Date()
	for off := -1; off <= 1; off++ {
		day := time.Date(y, m, d+off, 0, 0, 0, 0, s.loc)
		for _, sp := range s.weekly[day.Weekday()] {
			start := day.Add(time.Duration(sp.open) * time.Minute)
			endMin := sp.close
			if endMin <= sp.open {
				endMin += 24 * 60
			}
			end := day.Add(time.Duration(endMin) * time.Minute)
			if !t.Before(start.Add(-before)) && t.Before(end.Add(after)) {
				return true
			}
		}
	}
	return false
}

// IsOpen reports whether t is within business hours.
func (s *Schedule) IsOpen(t time.Time) bool {
	if s == nil {
		return true
	}
	return s.contains(t, 0, 0)
}

// InStaffWindow reports whether people are expected on site at t: business
// hours plus the pre-open and post-close allowances. Outside it, any person
// is an after-hours intrusion.
func (s *Schedule) InStaffWindow(t time.Time) bool {
	if s == nil {
		return true
	}
	return s.contains(t, s.staffBefore, s.staffAfter)
}

// Today lists the opening spans for t's local day as "HH:MM" pairs.
func (s *Schedule) Today(t time.Time) [][2]string {
	out := [][2]string{}
	if s == nil {
		return out
	}
	for _, sp := range s.weekly[t.In(s.loc).Weekday()] {
		out = append(out, [2]string{fmtHHMM(sp.open), fmtHHMM(sp.close)})
	}
	return out
}

func fmtHHMM(m int) string { return fmt.Sprintf("%02d:%02d", m/60%24, m%60) }
