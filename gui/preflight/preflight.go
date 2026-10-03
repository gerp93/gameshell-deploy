// Package preflight checks that the tools create.sh/delete.sh depend on
// (doctl, gpg, ssh/scp, and on Windows, WSL itself) are present before the
// GUI lets an operator start a run.
package preflight

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gameshell-deploy-gui/deployconf"
	"gameshell-deploy-gui/platform"
)

// repoCheckTimeout bounds each remote reachability probe so one unreachable
// host can't hold the whole prerequisites bar on "Checking…".
const repoCheckTimeout = 15 * time.Second

// CheckResult is one prerequisite's pass/fail state plus a short
// remediation hint shown when it fails.
type CheckResult struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Result is the full set of prerequisite checks. WSLBlocking is true only
// on Windows when wsl.exe itself isn't installed/responsive — in that case
// nothing else can be checked, and the GUI should show a blocking
// "Install WSL" panel instead of the rest of the checks.
type Result struct {
	WSLBlocking bool          `json:"wslBlocking"`
	Checks      []CheckResult `json:"checks"`
}

// RunChecks runs every prerequisite check and returns their results. opsDir
// is the gameshell-deploy checkout (where games/ lives); when empty, only the
// per-game repo reachability checks are skipped.
func RunChecks(opsDir string) Result {
	if platform.IsWindows() && !platform.WSLAvailable() {
		return Result{
			WSLBlocking: true,
			Checks: []CheckResult{
				{Name: "WSL", OK: false, Detail: "WSL is not installed or not responding. Install it with `wsl --install` in an admin PowerShell, then restart this app."},
			},
		}
	}

	checks := []CheckResult{
		checkDoctlInstalled(),
		checkDoctlAuthenticated(),
		checkTool("gpg", "GPG", "Install gpg (e.g. `sudo apt install gnupg` inside WSL, or `brew install gnupg` on macOS) — it encrypts/decrypts database backups."),
		checkTool("ssh", "SSH", "Install an OpenSSH client (e.g. `sudo apt install openssh-client` inside WSL) — it's used to reach the database droplet."),
		checkTool("scp", "SCP", "SCP normally ships with the OpenSSH client — install openssh-client if it's missing."),
		// Optional for the CLI (create.sh warns and carries on without it),
		// but required here: the GUI's region/tier dropdowns are built from
		// create.sh's --list-regions/--list-tiers, which refuse to guess
		// without jq rather than offer combinations that 422 at create time.
		checkTool("git", "git", "Install git (e.g. `sudo apt install git` inside WSL, or `brew install git` on macOS) — create.sh uses it to resolve the deploy branch and sync forks."),
		checkTool("jq", "jq", "Install jq (e.g. `sudo apt install jq` inside WSL, or `brew install jq` on macOS) — the Deploy tab's region and price tier lists are built from it."),
	}

	if platform.IsWindows() {
		checks = append([]CheckResult{
			{Name: "WSL", OK: true, Detail: "WSL is installed and responding."},
		}, checks...)
	}

	// Without git every repo probe would fail for the same reason the git
	// check above already reports.
	if platform.LookPath("git") {
		checks = append(checks, checkRepos(opsDir)...)
	}

	return Result{WSLBlocking: false, Checks: checks}
}

// repoTarget is one remote the games under games/ deploy from or sync with,
// plus the games that name it.
type repoTarget struct {
	repo   string // "owner/name", as in deploy.conf
	branch string // empty means the repo's default branch (HEAD)
	games  []string
}

// checkRepos probes every GIT_REPO and GIT_UPSTREAM named by a game's
// deploy.conf with the same `git ls-remote` create.sh runs before it creates
// anything, so a bad repo name, a typo'd branch, or a private repo this
// machine can't read shows up here instead of partway into a deploy.
func checkRepos(opsDir string) []CheckResult {
	if opsDir == "" {
		return nil
	}
	targets := repoTargets(opsDir)
	results := make([]CheckResult, len(targets))
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func(i int, t repoTarget) {
			defer wg.Done()
			results[i] = checkRepo(t)
		}(i, t)
	}
	wg.Wait()
	return results
}

// repoTargets collects the distinct repo+branch pairs across all games,
// in a stable order.
func repoTargets(opsDir string) []repoTarget {
	entries, err := os.ReadDir(filepath.Join(opsDir, "games"))
	if err != nil {
		return nil
	}
	byKey := map[string]*repoTarget{}
	var keys []string
	add := func(repo, branch, game string) {
		if repo == "" {
			return
		}
		key := repo + "@" + branch
		if t, ok := byKey[key]; ok {
			t.games = append(t.games, game)
			return
		}
		byKey[key] = &repoTarget{repo: repo, branch: branch, games: []string{game}}
		keys = append(keys, key)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(opsDir, "games", e.Name(), "deploy.conf")
		if !deployconf.Exists(path) {
			continue
		}
		conf, err := deployconf.Load(path)
		if err != nil {
			continue // the Config tab surfaces an unreadable deploy.conf
		}
		add(conf.GitRepo, conf.GitBranch, e.Name())
		add(conf.GitUpstream, conf.GitBranch, e.Name())
	}
	sort.Strings(keys)
	targets := make([]repoTarget, 0, len(keys))
	for _, k := range keys {
		targets = append(targets, *byKey[k])
	}
	return targets
}

func checkRepo(t repoTarget) CheckResult {
	name := "Repo " + t.repo
	where := "(" + strings.Join(t.games, ", ") + ")"

	// Same URL form and queries as create.sh. GIT_TERMINAL_PROMPT=0 makes a
	// repo that wants credentials fail fast instead of waiting on a prompt
	// nobody can answer.
	args := []string{"GIT_TERMINAL_PROMPT=0", "git", "ls-remote", "--exit-code"}
	branchLabel := "default branch"
	if t.branch != "" {
		args = append(args, "--heads", "https://github.com/"+t.repo+".git", t.branch)
		branchLabel = "branch " + t.branch
	} else {
		args = append(args, "https://github.com/"+t.repo+".git", "HEAD")
	}

	cmd, err := platform.RawCommand("env", args)
	if err != nil {
		return CheckResult{Name: name, OK: false, Detail: err.Error()}
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return CheckResult{Name: name, OK: false, Detail: err.Error()}
	}
	timedOut := false
	timer := time.AfterFunc(repoCheckTimeout, func() {
		timedOut = true
		_ = cmd.Process.Kill()
	})
	err = cmd.Wait()
	timer.Stop()

	if err == nil {
		return CheckResult{Name: name, OK: true, Detail: branchLabel + " reachable " + where + "."}
	}
	if timedOut {
		return CheckResult{Name: name, OK: false, Detail: "timed out reaching github.com " + where + " — check the network connection."}
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
		return CheckResult{Name: name, OK: false, Detail: "repo is reachable but has no " + branchLabel + " " + where + " — fix GIT_BRANCH in deploy.conf (blank uses the default branch)."}
	}
	reason := firstLine(stderr.String())
	if reason == "" {
		reason = err.Error()
	}
	return CheckResult{Name: name, OK: false, Detail: reason + " " + where + " — check GIT_REPO/GIT_UPSTREAM in deploy.conf; a private repo needs git credentials on this machine."}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	return s
}

func checkTool(bin, name, hint string) CheckResult {
	if platform.LookPath(bin) {
		return CheckResult{Name: name, OK: true, Detail: name + " found."}
	}
	return CheckResult{Name: name, OK: false, Detail: hint}
}

func checkDoctlInstalled() CheckResult {
	return checkTool("doctl", "doctl", "Install doctl (https://docs.digitalocean.com/reference/doctl/how-to/install/) — it drives every Digital Ocean API call these scripts make.")
}

func checkDoctlAuthenticated() CheckResult {
	if !platform.LookPath("doctl") {
		return CheckResult{Name: "doctl auth", OK: false, Detail: "doctl isn't installed yet."}
	}
	// Uses "apps list" rather than "account get" — this tool never reads
	// account info, only apps/droplets/ssh-keys, so a scoped token with
	// just those scopes (and no account:read) would otherwise fail this
	// check despite working fine for every real operation it performs.
	cmd, err := platform.RawCommand("doctl", []string{"apps", "list", "--format=ID", "--no-header"})
	if err != nil {
		return CheckResult{Name: "doctl auth", OK: false, Detail: err.Error()}
	}
	if err := cmd.Run(); err != nil {
		return CheckResult{Name: "doctl auth", OK: false, Detail: "doctl is not authenticated — run `doctl auth init -t $TOKEN`."}
	}
	return CheckResult{Name: "doctl auth", OK: true, Detail: "doctl is authenticated."}
}
