package scriptrunner

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"gameshell-deploy-gui/holocron"
	"gameshell-deploy-gui/platform"
)

// holocronQueryTimeout bounds funnel.sh's quick calls. They make one ssh round
// trip, and the GUI asks on a timer, so a box that is switched off must not pile
// up processes.
const holocronQueryTimeout = 60 * time.Second

// HolocronInfo is a TARGET=holocron game's state on the home server, as
// `funnel.sh APP info` reports it.
type HolocronInfo struct {
	// App is "running", "stopped" or "absent": the game's container.
	App string `json:"app"`
	// Database is whether the game's database exists in the shared MariaDB.
	Database bool `json:"database"`
	// Created is when the container was created (RFC 3339), "" when absent.
	Created string `json:"created"`
	// Funnel is whether Tailscale Funnel currently serves this game, and
	// FunnelURL the public address it is served at.
	Funnel    bool   `json:"funnel"`
	FunnelURL string `json:"funnelUrl"`
}

// parseHolocronInfo reads funnel.sh's HOLOCRON_INFO line:
//
//	HOLOCRON_INFO  app  database(yes|no)  created  funnel(yes|no)  funnel-url
//
// Other lines (progress noise, the occasional WSL banner) are skipped.
func parseHolocronInfo(out string) (HolocronInfo, error) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "HOLOCRON_INFO\t") {
			continue
		}
		fields := strings.Split(line, "\t")
		get := func(i int) string {
			if i < len(fields) {
				return strings.TrimSpace(fields[i])
			}
			return ""
		}
		info := HolocronInfo{
			App:       get(1),
			Database:  get(2) == "yes",
			Created:   get(3),
			Funnel:    get(4) == "yes",
			FunnelURL: get(5),
		}
		if info.App == "" {
			info.App = "absent"
		}
		return info, nil
	}
	return HolocronInfo{}, fmt.Errorf("funnel.sh info produced no result")
}

// holocronScript runs funnel.sh for a game with the home-server environment and
// returns its combined output. Time-limited; nothing here streams.
func holocronScript(opsDir, game string, args []string) (string, error) {
	env, err := holocron.ScriptEnv()
	if err != nil {
		return "", err
	}
	cmd, err := platform.ScriptCommand(filepath.Join(opsDir, "funnel.sh"), append([]string{game}, args...), env)
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		return "", err
	}
	timer := time.AfterFunc(holocronQueryTimeout, func() { _ = cmd.Process.Kill() })
	waitErr := cmd.Wait()
	timedOut := !timer.Stop()
	text := strings.TrimSpace(strings.ReplaceAll(out.String(), "\r", ""))
	if timedOut {
		return text, fmt.Errorf("the home server did not answer within %s", holocronQueryTimeout)
	}
	if waitErr != nil {
		if text == "" {
			return "", waitErr
		}
		return text, fmt.Errorf("%s", lastNonEmptyLine(text))
	}
	return text, nil
}

// CheckHolocron asks the home server about a TARGET=holocron game. game is the
// games/ directory name.
func CheckHolocron(opsDir, game string) (HolocronInfo, error) {
	out, err := holocronScript(opsDir, game, []string{"info"})
	if err != nil {
		return HolocronInfo{}, err
	}
	return parseHolocronInfo(out)
}

// RunFunnel turns Tailscale Funnel on or off for a game, or reports it
// ("status"). "on" publishes the game on the internet, so it is only ever
// started by an explicit click in the GUI, which asks first; --yes here only
// stands in for the terminal prompt the script would otherwise ask.
func RunFunnel(opsDir, game, action string) (string, error) {
	switch action {
	case "on":
		return holocronScript(opsDir, game, []string{"on", "--yes"})
	case "off", "status":
		return holocronScript(opsDir, game, []string{action})
	}
	return "", fmt.Errorf("unknown Funnel action: %s", action)
}

// StatusResult maps the home-server state onto the shape the rest of the GUI
// already understands: the database is the "droplet" and the container the
// "app", so a game is Deployed when both exist and "partial" when only one
// does. lanURL is the game's address on the home network (blank when the game
// is only published on the box itself); the Funnel address wins when it is on.
func (i HolocronInfo) StatusResult(lanURL string) StatusResult {
	res := StatusResult{
		DropletExists: i.Database,
		AppExists:     i.App != "" && i.App != "absent",
		Holocron:      true,
		FunnelOn:      i.Funnel,
	}
	if res.AppExists {
		res.UpSince = i.Created
		switch {
		case i.Funnel && i.FunnelURL != "":
			res.AppURL = i.FunnelURL
		case i.App == "running":
			res.AppURL = lanURL
		}
	}
	return res
}
