package eventengine

import (
	"fmt"
	"sort"
	"time"
)

// RuleOverride lets a site tune a rule from its site config.
type RuleOverride struct {
	Policy Policy `json:"policy,omitempty"`
	// AlertingEnabled turns an alert-policy rule from SHADOW into real alerts.
	// The owner sets it after the shadow tuning period; core audits every
	// enabled rule at startup (ADR-008).
	AlertingEnabled bool    `json:"alerting_enabled,omitempty"`
	MinDurationS    float64 `json:"min_duration_s,omitempty"`
	MaxPeople       int     `json:"max_people,omitempty"`
}

// RuleNames lists every rule a site config may name.
func RuleNames() []string {
	names := make([]string, 0, len(defaultConfigs))
	for n := range defaultConfigs {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// defaultConfigs are the pilot starting points (AI_MODEL_STRATEGY). Nothing
// alerts by default: alert-policy rules produce SHADOW incidents until the
// site enables them.
var defaultConfigs = map[string]RuleConfig{
	"after_hours_intrusion":  {MinDuration: 2 * time.Second, MergeGap: 5 * time.Minute, Policy: PolicyAlert, InconclusiveOnLoss: true},
	"camera_tamper":          {MinDuration: 30 * time.Second, MergeGap: 0, Policy: PolicyAlert},
	"restricted_zone_entry":  {MinDuration: 3 * time.Second, MergeGap: time.Minute, Policy: PolicyReview, InconclusiveOnLoss: true},
	"person_down":            {MinDuration: 3 * time.Second, MergeGap: time.Minute, Policy: PolicyAlert},
	"long_queue":             {MinDuration: time.Minute, MergeGap: 5 * time.Minute, Policy: PolicyAlert},
	"long_wait":              {MinDuration: 8 * time.Minute, MergeGap: 2 * time.Minute, Policy: PolicyReview},
	"unattended_post":        {MinDuration: 3 * time.Minute, MergeGap: 2 * time.Minute, Policy: PolicyAlert},
	"pos_no_sale":            {Policy: PolicyReview},
	"pos_refund_no_customer": {Policy: PolicyAlert},
}

// ValidateOverrides checks a site's rule overrides.
func ValidateOverrides(overrides map[string]RuleOverride) error {
	for name, o := range overrides {
		if _, ok := defaultConfigs[name]; !ok {
			return fmt.Errorf("unknown rule %q (known: %v)", name, RuleNames())
		}
		if o.Policy != "" && o.Policy != PolicyAlert && o.Policy != PolicyReview {
			return fmt.Errorf("rule %q: policy must be alert or review", name)
		}
		if o.MinDurationS < 0 || o.MinDurationS > 24*3600 {
			return fmt.Errorf("rule %q: min_duration_s out of range", name)
		}
		if o.MaxPeople < 0 || (o.MaxPeople > 0 && name != "long_queue") {
			return fmt.Errorf("rule %q: max_people only applies to long_queue", name)
		}
		if o.MinDurationS > 0 && (name == "pos_no_sale" || name == "pos_refund_no_customer") {
			return fmt.Errorf("rule %q: min_duration_s does not apply to POS rules", name)
		}
	}
	return nil
}

// DefaultRules builds every rule, with site overrides applied. Call
// ValidateOverrides first; unknown names are ignored here.
func DefaultRules(overrides map[string]RuleOverride) []Rule {
	cfg := func(name string) RuleConfig {
		c := defaultConfigs[name]
		if o, ok := overrides[name]; ok {
			if o.Policy != "" {
				c.Policy = o.Policy
			}
			c.AlertingEnabled = o.AlertingEnabled
			if o.MinDurationS > 0 {
				c.MinDuration = time.Duration(o.MinDurationS * float64(time.Second))
			}
		}
		return c
	}
	maxPeople := 5
	if o, ok := overrides["long_queue"]; ok && o.MaxPeople > 0 {
		maxPeople = o.MaxPeople
	}
	return []Rule{
		&AfterHoursIntrusion{Cfg: cfg("after_hours_intrusion"), MinScore: 0.5},
		&RestrictedZoneEntry{Cfg: cfg("restricted_zone_entry"), MinScore: 0.5},
		&PersonDown{Cfg: cfg("person_down"), MinScore: 0.4, MinAspect: 1.3},
		&LongQueue{Cfg: cfg("long_queue"), MaxPeople: maxPeople},
		&LongWait{Cfg: cfg("long_wait")},
		&UnattendedPost{Cfg: cfg("unattended_post")},
		&CameraTamper{Cfg: cfg("camera_tamper")},
		&POSNoSale{Cfg: cfg("pos_no_sale")},
		&POSRefundNoCustomer{Cfg: cfg("pos_refund_no_customer"), Before: 20 * time.Second, After: 5 * time.Second},
	}
}

// SetCamera registers or replaces a camera. Like Process, it must be called
// from the goroutine that owns the engine.
func (e *Engine) SetCamera(c Camera) { e.cameras[c.ID] = c }
