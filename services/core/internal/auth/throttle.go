package auth

import (
	"sync"
	"time"
)

// Throttle limits online password guessing. It counts failed logins per
// username and per client IP in a sliding window; once a limit is reached
// that key is locked for the lock duration. Successful logins clear the
// username's count. State is in memory: a restart clears it, which is
// acceptable for a single edge appliance.
type Throttle struct {
	PerUser  int           // failures per username before lock (default 5)
	PerIP    int           // failures per client IP before lock (default 30)
	Window   time.Duration // counting window (default 15 min)
	LockFor  time.Duration // lock duration (default 15 min)
	MaxKeys  int           // memory bound (default 10000)
	now      func() time.Time
	mu       sync.Mutex
	failures map[string][]time.Time
	locked   map[string]time.Time
}

func (t *Throttle) init() {
	if t.failures == nil {
		t.failures = map[string][]time.Time{}
		t.locked = map[string]time.Time{}
	}
	if t.PerUser <= 0 {
		t.PerUser = 5
	}
	if t.PerIP <= 0 {
		t.PerIP = 30
	}
	if t.Window <= 0 {
		t.Window = 15 * time.Minute
	}
	if t.LockFor <= 0 {
		t.LockFor = 15 * time.Minute
	}
	if t.MaxKeys <= 0 {
		t.MaxKeys = 10000
	}
	if t.now == nil {
		t.now = time.Now
	}
}

func userKey(u string) string { return "u:" + u }
func ipKey(ip string) string  { return "i:" + ip }

// Locked reports whether either key is locked and, if so, for how long.
func (t *Throttle) Locked(user, ip string) (bool, time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	now := t.now()
	var wait time.Duration
	for _, k := range []string{userKey(user), ipKey(ip)} {
		if until, ok := t.locked[k]; ok {
			if now.Before(until) {
				if d := until.Sub(now); d > wait {
					wait = d
				}
			} else {
				delete(t.locked, k)
			}
		}
	}
	return wait > 0, wait
}

// Fail records a failed login and reports whether this failure caused a new
// lock (so the caller can audit the lock once).
func (t *Throttle) Fail(user, ip string) (newlyLocked bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	now := t.now()
	if len(t.failures) > t.MaxKeys {
		t.gc(now)
	}
	for _, kl := range []struct {
		key   string
		limit int
	}{{userKey(user), t.PerUser}, {ipKey(ip), t.PerIP}} {
		l := t.failures[kl.key][:0]
		for _, at := range t.failures[kl.key] {
			if now.Sub(at) < t.Window {
				l = append(l, at)
			}
		}
		l = append(l, now)
		t.failures[kl.key] = l
		if len(l) >= kl.limit {
			if _, already := t.locked[kl.key]; !already {
				newlyLocked = true
			}
			t.locked[kl.key] = now.Add(t.LockFor)
			delete(t.failures, kl.key)
		}
	}
	return newlyLocked
}

// Succeed clears a username's failure count.
func (t *Throttle) Succeed(user string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	delete(t.failures, userKey(user))
}

func (t *Throttle) gc(now time.Time) {
	for k, l := range t.failures {
		if len(l) == 0 || now.Sub(l[len(l)-1]) >= t.Window {
			delete(t.failures, k)
		}
	}
	for k, until := range t.locked {
		if !now.Before(until) {
			delete(t.locked, k)
		}
	}
}
