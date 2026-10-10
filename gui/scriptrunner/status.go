package scriptrunner

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type dropletInfo struct {
	name      string
	createdAt time.Time
}

type appInfo struct {
	name      string
	ingress   string
	createdAt time.Time
}

// resourceSnapshot is every droplet and app on the account at one moment, so
// the status of any number of games can be answered from two doctl calls.
type resourceSnapshot struct {
	droplets []dropletInfo
	apps     []appInfo
}

// listResources reads droplets and apps as JSON rather than --format columns:
// a creation time contains spaces, which would break the whitespace-split
// parsing the column output relies on.
func listResources() (resourceSnapshot, error) {
	dropletOut, err := runDoctl("compute", "droplet", "list", "-o", "json")
	if err != nil {
		return resourceSnapshot{}, err
	}
	appOut, err := runDoctl("apps", "list", "-o", "json")
	if err != nil {
		return resourceSnapshot{}, err
	}
	droplets, err := parseDroplets(dropletOut)
	if err != nil {
		return resourceSnapshot{}, err
	}
	apps, err := parseApps(appOut)
	if err != nil {
		return resourceSnapshot{}, err
	}
	return resourceSnapshot{droplets: droplets, apps: apps}, nil
}

func parseDroplets(out string) ([]dropletInfo, error) {
	var raw []struct {
		Name      string    `json:"name"`
		CreatedAt time.Time `json:"created_at"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("could not read doctl droplet list output: %w", err)
	}
	droplets := make([]dropletInfo, 0, len(raw))
	for _, d := range raw {
		droplets = append(droplets, dropletInfo{name: d.Name, createdAt: d.CreatedAt})
	}
	return droplets, nil
}

func parseApps(out string) ([]appInfo, error) {
	var raw []struct {
		DefaultIngress string    `json:"default_ingress"`
		CreatedAt      time.Time `json:"created_at"`
		Spec           struct {
			Name string `json:"name"`
		} `json:"spec"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("could not read doctl apps list output: %w", err)
	}
	apps := make([]appInfo, 0, len(raw))
	for _, a := range raw {
		apps = append(apps, appInfo{name: a.Spec.Name, ingress: a.DefaultIngress, createdAt: a.CreatedAt})
	}
	return apps, nil
}

// statusFor matches appName (deploy.conf's APP_NAME) with the same rules
// create.sh/delete.sh use: a droplet whose name contains "APP_NAME-database",
// and the first app whose spec name contains APP_NAME.
func (s resourceSnapshot) statusFor(appName string) StatusResult {
	var result StatusResult
	if appName == "" {
		return result
	}
	var upSince time.Time
	earlier := func(t time.Time) {
		if !t.IsZero() && (upSince.IsZero() || t.Before(upSince)) {
			upSince = t
		}
	}
	for _, d := range s.droplets {
		if strings.Contains(d.name, appName+"-database") {
			result.DropletExists = true
			earlier(d.createdAt)
			break
		}
	}
	for _, a := range s.apps {
		if strings.Contains(a.name, appName) {
			result.AppExists = true
			result.AppURL = a.ingress
			earlier(a.createdAt)
			break
		}
	}
	if !upSince.IsZero() {
		result.UpSince = upSince.UTC().Format(time.RFC3339)
	}
	return result
}

// GameStatus is one game's row in the sidebar: its Digital Ocean status plus
// the deploy.conf values the sidebar needs without selecting the game.
type GameStatus struct {
	// Game is the games/ directory name (what the sidebar lists).
	Game string `json:"game"`
	// HasConf is false when games/Game has no deploy.conf yet (a game that
	// was added but not configured), in which case there is nothing to look up.
	HasConf bool `json:"hasConf"`
	// MaxUptimeHours is deploy.conf's MAX_UPTIME_HOURS; 0 means no limit.
	MaxUptimeHours int          `json:"maxUptimeHours"`
	Status         StatusResult `json:"status"`
}

// GameRef is what ListGameStatuses needs to know about a game from its
// deploy.conf, supplied by the caller so this package stays free of the
// deploy.conf parser.
type GameRef struct {
	Game           string
	HasConf        bool
	AppName        string
	MaxUptimeHours int
}

// ListGameStatuses answers every game's Digital Ocean status from a single
// pair of doctl calls, however many games there are.
func ListGameStatuses(games []GameRef) ([]GameStatus, error) {
	snap, err := listResources()
	if err != nil {
		return nil, err
	}
	out := make([]GameStatus, 0, len(games))
	for _, g := range games {
		gs := GameStatus{Game: g.Game, HasConf: g.HasConf, MaxUptimeHours: g.MaxUptimeHours}
		if g.HasConf {
			gs.Status = snap.statusFor(g.AppName)
		}
		out = append(out, gs)
	}
	return out, nil
}
