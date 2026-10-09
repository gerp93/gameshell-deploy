package scriptrunner

import "testing"

const dropletsJSON = `[
  {"id": 1, "name": "track-timeline-database", "created_at": "2026-10-03T17:02:09Z"},
  {"id": 2, "name": "unrelated", "created_at": "2026-01-01T00:00:00Z"}
]`

const appsJSON = `[
  {"id": "a", "default_ingress": "https://track-timeline-x.ondigitalocean.app",
   "created_at": "2026-10-03T17:06:36Z", "spec": {"name": "track-timeline"}},
  {"id": "b", "default_ingress": "", "created_at": "2026-10-04T00:00:00Z", "spec": {"name": "card-judge"}}
]`

func snapshot(t *testing.T, droplets, apps string) resourceSnapshot {
	t.Helper()
	d, err := parseDroplets(droplets)
	if err != nil {
		t.Fatal(err)
	}
	a, err := parseApps(apps)
	if err != nil {
		t.Fatal(err)
	}
	return resourceSnapshot{droplets: d, apps: a}
}

func TestStatusForDeployed(t *testing.T) {
	got := snapshot(t, dropletsJSON, appsJSON).statusFor("track-timeline")
	if !got.DropletExists || !got.AppExists {
		t.Fatalf("expected droplet and app, got %+v", got)
	}
	if got.AppURL != "https://track-timeline-x.ondigitalocean.app" {
		t.Errorf("AppURL = %q", got.AppURL)
	}
	// The droplet is created first, so it sets the clock.
	if got.UpSince != "2026-10-03T17:02:09Z" {
		t.Errorf("UpSince = %q, want the droplet's creation time", got.UpSince)
	}
}

func TestStatusForPartial(t *testing.T) {
	got := snapshot(t, dropletsJSON, appsJSON).statusFor("card-judge")
	if got.DropletExists || !got.AppExists {
		t.Fatalf("expected app only, got %+v", got)
	}
	if got.UpSince != "2026-10-04T00:00:00Z" {
		t.Errorf("UpSince = %q", got.UpSince)
	}
}

func TestStatusForDown(t *testing.T) {
	got := snapshot(t, dropletsJSON, appsJSON).statusFor("timeline-trivia")
	if got != (StatusResult{}) {
		t.Fatalf("expected zero status, got %+v", got)
	}
}

func TestStatusForEmptyName(t *testing.T) {
	// strings.Contains(x, "") is always true; an unset APP_NAME must not
	// claim every game is deployed.
	got := snapshot(t, dropletsJSON, appsJSON).statusFor("")
	if got != (StatusResult{}) {
		t.Fatalf("expected zero status, got %+v", got)
	}
}

func TestParseEmptyAccount(t *testing.T) {
	// doctl prints [] for an account with nothing in it.
	s := snapshot(t, "[]", "[]")
	if got := s.statusFor("track-timeline"); got != (StatusResult{}) {
		t.Fatalf("expected zero status, got %+v", got)
	}
}

func TestParseRejectsErrorOutput(t *testing.T) {
	if _, err := parseApps(`{"errors":[{"detail":"access token is required"}]}`); err == nil {
		t.Fatal("expected an error for doctl's error object")
	}
}
