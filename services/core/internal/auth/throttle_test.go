package auth

import (
	"testing"
	"time"
)

func TestThrottleLocksUsernameAfterFiveFailures(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	th := &Throttle{now: func() time.Time { return now }}
	for i := 0; i < 4; i++ {
		if th.Fail("sam", "10.0.0.1") {
			t.Fatalf("locked too early at failure %d", i+1)
		}
	}
	if locked, _ := th.Locked("sam", "10.0.0.9"); locked {
		t.Fatal("4 failures must not lock")
	}
	if !th.Fail("sam", "10.0.0.1") {
		t.Fatal("5th failure must report a new lock")
	}
	if locked, wait := th.Locked("sam", "10.0.0.9"); !locked || wait != 15*time.Minute {
		t.Fatalf("username must be locked from any IP for 15 min, got %v %v", locked, wait)
	}
	if locked, _ := th.Locked("other", "10.0.0.9"); locked {
		t.Fatal("other users are not affected")
	}
	now = now.Add(15*time.Minute + time.Second)
	if locked, _ := th.Locked("sam", "10.0.0.9"); locked {
		t.Fatal("lock must expire")
	}
}

func TestThrottleSuccessResetsAndWindowSlides(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	th := &Throttle{now: func() time.Time { return now }}
	for i := 0; i < 4; i++ {
		th.Fail("sam", "ip")
	}
	th.Succeed("sam")
	for i := 0; i < 4; i++ {
		th.Fail("sam", "ip")
	}
	if locked, _ := th.Locked("sam", "x"); locked {
		t.Fatal("success must reset the username count")
	}
	now = now.Add(16 * time.Minute)
	th.Fail("sam", "ip")
	if locked, _ := th.Locked("sam", "x"); locked {
		t.Fatal("old failures fall out of the window")
	}
}

func TestThrottleLocksIPAcrossUsernames(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	th := &Throttle{now: func() time.Time { return now }, PerIP: 3}
	th.Fail("a", "1.2.3.4")
	th.Fail("b", "1.2.3.4")
	th.Fail("c", "1.2.3.4")
	if locked, _ := th.Locked("d", "1.2.3.4"); !locked {
		t.Fatal("spraying usernames from one IP must lock the IP")
	}
}

func TestRolePermissions(t *testing.T) {
	cases := []struct {
		role string
		p    Permission
		want bool
	}{
		{"staff", PermAcknowledge, true},
		{"staff", PermViewClips, false},
		{"manager", PermViewClips, true},
		{"manager", PermDisposition, true},
		{"manager", PermAnalytics, true},
		{"manager", PermViewShadow, false},
		{"owner", PermLegalHold, true},
		{"owner", PermAdmin, false},
		{"admin", PermViewClips, false}, // separation of duties
		{"admin", PermAdmin, true},
		{"caregiver", PermViewStatus, false},
	}
	for _, c := range cases {
		if got := Can(c.role, c.p); got != c.want {
			t.Errorf("Can(%s, %s) = %v, want %v", c.role, c.p, got, c.want)
		}
	}
}
