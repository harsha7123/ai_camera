package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/harsha7123/ai_camera/services/core/internal/eventengine"
)

// TestHarborGrillFixture replays tests/fixtures (see generate_mock.py for the
// scenario) through the example site config and checks every outcome.
func TestHarborGrillFixture(t *testing.T) {
	var buf bytes.Buffer
	if err := run("../../site.example.json", "../../../../tests/fixtures/mock_observations.jsonl",
		"../../../../tests/fixtures/mock_pos.jsonl", &buf); err != nil {
		t.Fatal(err)
	}
	got := map[string]eventengine.IncidentStatus{}
	entries, exits, access := 0, 0, 0
	dec := json.NewDecoder(&buf)
	for dec.More() {
		var o eventengine.Output
		if err := dec.Decode(&o); err != nil {
			t.Fatal(err)
		}
		switch o.Kind {
		case "incident_created":
			if _, dup := got[o.Incident.EventType]; dup {
				t.Errorf("duplicate %s incident", o.Incident.EventType)
			}
			got[o.Incident.EventType] = o.Incident.Status
			if o.Incident.Source != eventengine.SourceMock && o.Incident.Source != eventengine.SourcePOS {
				t.Errorf("fixture incident %s has source %q", o.Incident.ID, o.Incident.Source)
			}
		case "traffic":
			entries += o.Traffic.Entries
			exits += o.Traffic.Exits
		case "zone_access":
			access++
			if o.Access.Role != eventengine.RoleStaff || o.Access.ZoneID != "cooler-door" {
				t.Errorf("unexpected access entry %+v", o.Access)
			}
		}
	}
	want := map[string]eventengine.IncidentStatus{
		"restricted_zone_entry":  eventengine.StatusReview,
		"pos_no_sale":            eventengine.StatusReview,
		"person_down":            eventengine.StatusShadow,
		"pos_refund_no_customer": eventengine.StatusShadow,
	}
	if len(got) != len(want) {
		t.Errorf("incidents %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: got %q, want %q", k, got[k], v)
		}
	}
	if entries != 2 || exits != 1 || access != 1 {
		t.Errorf("entries=%d exits=%d access=%d, want 2/1/1", entries, exits, access)
	}
}
