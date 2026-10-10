package scriptrunner

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gameshell-deploy-gui/platform"
)

// checkRedeployTimeout bounds `redeploy.sh --check`. It makes a couple of
// network calls (doctl, git ls-remote, and a git fetch when the branch has
// moved), and the GUI calls it on a timer, so a hung connection must not pile
// up processes forever.
const checkRedeployTimeout = 90 * time.Second

// Possible RedeployCheck.State values, as redeploy.sh --check prints them.
const (
	RedeployCurrent = "current" // deployed commit is the latest on the branch
	RedeployBehind  = "behind"  // the branch has commits that aren't deployed
	RedeployUnknown = "unknown" // couldn't compare; Note says why
	RedeployNoApp   = "no-app"  // nothing is deployed for this game
)

// RedeployCheck is what `redeploy.sh APP_NAME --check` reports: whether the
// branch has code newer than what's deployed, so the GUI can offer a redeploy
// proactively. Redeploying never requires State to be "behind" — this only
// says whether there's something new to ship.
type RedeployCheck struct {
	State    string `json:"state"`
	Deployed string `json:"deployed"`
	Latest   string `json:"latest"`
	// Commits is how many commits the branch is ahead of what's deployed, or
	// -1 when that couldn't be counted.
	Commits int    `json:"commits"`
	Branch  string `json:"branch"`
	Note    string `json:"note"`
	// DestructiveSQL is the "file: line" hits for SQL the new commits add that
	// removes or rewrites data/columns — the same lines redeploy.sh's own
	// pre-deploy warning prints. Never nil, so it marshals to [] not null.
	DestructiveSQL []string `json:"destructiveSql"`
}

// CheckRedeploy runs `redeploy.sh APP_NAME --check`. appName is the games/
// directory name, as for RunRedeploy. Reusing the shell logic here instead of
// re-implementing the git/doctl comparison in Go keeps the GUI and CLI from
// silently drifting apart, same as ListAvailableTiers.
func CheckRedeploy(opsDir, appName string) (RedeployCheck, error) {
	scriptPath := filepath.Join(opsDir, "redeploy.sh")
	cmd, err := platform.ScriptCommand(scriptPath, []string{appName, "--check"}, nil)
	if err != nil {
		return RedeployCheck{}, err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return RedeployCheck{}, err
	}
	timer := time.AfterFunc(checkRedeployTimeout, func() { _ = cmd.Process.Kill() })
	waitErr := cmd.Wait()
	timedOut := !timer.Stop()

	if timedOut {
		return RedeployCheck{}, fmt.Errorf("redeploy.sh --check timed out after %s", checkRedeployTimeout)
	}
	result, parseErr := parseRedeployCheck(stdout.String())
	if parseErr == nil {
		return result, nil
	}
	// No result line: the script bailed early (bad deploy.conf, branch missing
	// from the remote…). Its explanation is on stdout or stderr.
	detail := strings.TrimSpace(stderr.String())
	if detail == "" {
		detail = lastNonEmptyLine(stdout.String())
	}
	if waitErr != nil && detail != "" {
		return RedeployCheck{}, fmt.Errorf("redeploy.sh --check failed: %s", detail)
	}
	return RedeployCheck{}, parseErr
}

// parseRedeployCheck reads redeploy.sh --check's output. Only lines with its
// two prefixes count; everything else is progress noise (and, on Windows, the
// occasional WSL banner), so it's skipped rather than treated as an error.
func parseRedeployCheck(out string) (RedeployCheck, error) {
	result := RedeployCheck{Commits: -1, DestructiveSQL: []string{}}
	found := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "REDEPLOY_CHECK_SQL\t"):
			result.DestructiveSQL = append(result.DestructiveSQL, strings.TrimPrefix(line, "REDEPLOY_CHECK_SQL\t"))
		case strings.HasPrefix(line, "REDEPLOY_CHECK\t"):
			// REDEPLOY_CHECK STATE DEPLOYED LATEST COMMITS BRANCH NOTE — the
			// trailing fields are blank rather than absent, but tolerate a
			// short line anyway.
			fields := strings.Split(line, "\t")
			get := func(i int) string {
				if i < len(fields) {
					return fields[i]
				}
				return ""
			}
			result.State = get(1)
			result.Deployed = get(2)
			result.Latest = get(3)
			if n, err := strconv.Atoi(get(4)); err == nil {
				result.Commits = n
			}
			result.Branch = get(5)
			result.Note = get(6)
			found = true
		}
	}
	if !found {
		return RedeployCheck{}, fmt.Errorf("redeploy.sh --check produced no result")
	}
	return result, nil
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
