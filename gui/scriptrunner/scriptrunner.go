// Package scriptrunner invokes create.sh/delete.sh non-interactively (via
// their --ssh-key/--tier/--yes/--backup flags) and streams their stdout and
// stderr line-by-line to a caller-supplied Emitter. Runs are tracked per app
// name, so deploying/tearing down two different games at once is supported
// — each gets its own process and its own stream of events.
package scriptrunner

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"gameshell-deploy-gui/platform"
)

// LogLine is one line of a running script's stdout or stderr, tagged with
// the app name it belongs to so the frontend can route it to the right
// game's log pane even when multiple runs are in flight.
type LogLine struct {
	AppName string `json:"appName"`
	Stream  string `json:"stream"`
	Text    string `json:"text"`
}

// ExitInfo reports how a script run finished.
type ExitInfo struct {
	AppName string `json:"appName"`
	Code    int    `json:"code"`
	Err     string `json:"err,omitempty"`
}

// Emitter delivers log lines and the final exit status to the frontend. In
// app.go this is backed by Wails' runtime.EventsEmit; kept as an interface
// here so this package has no dependency on the Wails runtime.
type Emitter interface {
	EmitLog(event string, line LogLine)
	EmitExit(event string, info ExitInfo)
}

// CreateRequest mirrors create.sh's positional arg + flags.
type CreateRequest struct {
	OpsDir     string `json:"opsDir"`
	AppName    string `json:"appName"`
	SSHKeyName string `json:"sshKeyName"`
	Tier       string `json:"tier"`
	// Region is optional and overrides deploy.conf's DROPLET_REGION for this
	// deploy only (create.sh never rewrites the tracked config).
	Region        string `json:"region"`
	AutoYes       bool   `json:"autoYes"`
	SQLUser       string `json:"sqlUser"`
	SQLPassword   string `json:"sqlPassword"`
	GPGPassphrase string `json:"gpgPassphrase"`
	// ExtraEnv is KEY=value pairs listed (by name) in deploy.conf's
	// EXTRA_ENV_VARS. Keys are the env var names copied onto the DO app;
	// values come from the operator (never from deploy.conf).
	ExtraEnv map[string]string `json:"extraEnv"`
}

// DeleteRequest mirrors delete.sh's positional arg + flag. Backup is
// "yes" or "no" — matching --backup=yes|no; leave empty to fall back to
// delete.sh's own interactive prompt (not used by the GUI, but supported
// for completeness).
type DeleteRequest struct {
	OpsDir        string `json:"opsDir"`
	AppName       string `json:"appName"`
	Backup        string `json:"backup"`
	GPGPassphrase string `json:"gpgPassphrase"`
}

// runningCmds tracks the one in-flight script per app name — deploying or
// tearing down the same game twice at once isn't allowed, but different
// games run fully independently.
var (
	runningMu   sync.Mutex
	runningCmds = map[string]platform.Cmd{}
)

// RunCreate runs create.sh to completion, streaming output via emit under
// the "create:log" / "create:exit" events (each tagged with req.AppName).
func RunCreate(req CreateRequest, emit Emitter) error {
	args := []string{req.AppName}
	if req.SSHKeyName != "" {
		args = append(args, "--ssh-key="+req.SSHKeyName)
	}
	if req.Tier != "" {
		args = append(args, "--tier="+req.Tier)
	}
	if req.Region != "" {
		args = append(args, "--region="+req.Region)
	}
	if req.AutoYes {
		args = append(args, "--yes")
	}
	env := []string{
		"DEPLOY_SQL_USER=" + req.SQLUser,
		"DEPLOY_SQL_PASSWORD=" + req.SQLPassword,
	}
	if req.GPGPassphrase != "" {
		env = append(env, "GPG_PASSPHRASE="+req.GPGPassphrase)
	}
	for k, v := range req.ExtraEnv {
		env = append(env, k+"="+v)
	}
	scriptPath := filepath.Join(req.OpsDir, "create.sh")
	return run(req.AppName, scriptPath, args, env, "create", emit)
}

// RunDelete runs delete.sh to completion, streaming output via emit under
// the "delete:log" / "delete:exit" events (each tagged with req.AppName).
func RunDelete(req DeleteRequest, emit Emitter) error {
	args := []string{req.AppName}
	if req.Backup != "" {
		args = append(args, "--backup="+req.Backup)
	}
	var env []string
	if req.GPGPassphrase != "" {
		env = append(env, "GPG_PASSPHRASE="+req.GPGPassphrase)
	}
	scriptPath := filepath.Join(req.OpsDir, "delete.sh")
	return run(req.AppName, scriptPath, args, env, "delete", emit)
}

// TierOption is one price tier create.sh's --list-tiers reported as
// available in the game's configured region. Number is the stable 1-based
// tier number create.sh's --tier= flag expects back — it does NOT shift
// based on which tiers are available (see create.sh's "get price tier"
// section for why that distinction matters).
type TierOption struct {
	Number  int    `json:"number"`
	Slug    string `json:"slug"`
	AppSize string `json:"appSize"`
	Label   string `json:"label"`
}

// ListAvailableTiers runs `create.sh APP_NAME --list-tiers`, which performs
// the same region-availability check create.sh itself runs before deploying
// (see its "get price tier" section) and exits without touching secrets,
// backups, or the network beyond that check. Reusing the shell logic here
// instead of reimplementing the jq/region-matching in Go keeps the GUI and
// CLI paths from silently drifting apart.
// region is optional: empty means "whatever deploy.conf's DROPLET_REGION
// says", anything else is passed through as --region= to check a region the
// operator is considering without editing the tracked config.
func ListAvailableTiers(opsDir, appName, region string) ([]TierOption, error) {
	scriptPath := filepath.Join(opsDir, "create.sh")
	args := []string{appName, "--list-tiers"}
	if region != "" {
		args = append(args, "--region="+region)
	}
	cmd, err := platform.ScriptCommand(scriptPath, args, nil)
	if err != nil {
		return nil, err
	}
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("create.sh --list-tiers failed: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return nil, err
	}

	// Non-nil so this marshals to [] rather than null when no tier is
	// available in the configured region — that's a legitimate result (the
	// AMD sizes aren't sold in every region, notably not the nyc3 default),
	// not an error, and the frontend iterates what it gets back.
	tiers := []TierOption{}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 4 {
			continue
		}
		number, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		tiers = append(tiers, TierOption{Number: number, Slug: fields[1], AppSize: fields[2], Label: fields[3]})
	}
	return tiers, nil
}

// RegionOption is one Digital Ocean region that offers at least one of the
// price tiers, as reported by create.sh's --list-regions.
type RegionOption struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// ListAvailableRegions runs `create.sh APP_NAME --list-regions`, the same
// list create.sh's interactive retry prompt offers when the configured
// region has no tiers available.
func ListAvailableRegions(opsDir, appName string) ([]RegionOption, error) {
	scriptPath := filepath.Join(opsDir, "create.sh")
	cmd, err := platform.ScriptCommand(scriptPath, []string{appName, "--list-regions"}, nil)
	if err != nil {
		return nil, err
	}
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("create.sh --list-regions failed: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return nil, err
	}

	regions := []RegionOption{}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 2 {
			continue
		}
		regions = append(regions, RegionOption{Slug: fields[0], Name: fields[1]})
	}
	return regions, nil
}

// ListSSHKeys runs `doctl compute ssh-key list` (via WSL on Windows) and
// returns the key names for the deploy-panel dropdown.
func ListSSHKeys() ([]string, error) {
	cmd, err := platform.RawCommand("doctl", []string{"compute", "ssh-key", "list", "--format=Name", "--no-header"})
	if err != nil {
		return nil, err
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var names []string
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		if line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// StatusResult reports whether a droplet/app for a game already exist on
// Digital Ocean, so the GUI knows whether it's set up for a Deploy or a
// Teardown.
type StatusResult struct {
	DropletExists bool `json:"dropletExists"`
	AppExists     bool `json:"appExists"`
	// AppURL is the deployed app's public ingress URL, empty when no app
	// exists (or when DO hasn't assigned one yet — it can lag briefly right
	// after a deploy).
	AppURL string `json:"appURL"`
}

// CheckStatus looks up appName (deploy.conf's APP_NAME, not the games/
// directory name) the same way create.sh/delete.sh do: droplet named
// "APP_NAME-database", and an app whose spec name contains APP_NAME.
func CheckStatus(appName string) (StatusResult, error) {
	dropletOut, err := runDoctl("compute", "droplet", "list", "--format=Name", "--no-header")
	if err != nil {
		return StatusResult{}, err
	}
	// Same DefaultIngress,Spec.Name pairing create.sh reads the URL from
	// after a deploy, so the GUI reports exactly what the script would.
	appOut, err := runDoctl("apps", "list", "--format=DefaultIngress,Spec.Name", "--no-header")
	if err != nil {
		return StatusResult{}, err
	}
	result := StatusResult{
		DropletExists: containsLine(dropletOut, appName+"-database"),
	}
	scanner := bufio.NewScanner(strings.NewReader(appOut))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// A freshly-created app can appear with no ingress assigned yet, so
		// the name is the last field rather than a fixed index.
		if len(fields) == 0 || !strings.Contains(fields[len(fields)-1], appName) {
			continue
		}
		result.AppExists = true
		if len(fields) > 1 {
			result.AppURL = fields[0]
		}
		break
	}
	return result, nil
}

func runDoctl(args ...string) (string, error) {
	cmd, err := platform.RawCommand("doctl", args)
	if err != nil {
		return "", err
	}
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func containsLine(output, substr string) bool {
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), substr) {
			return true
		}
	}
	return false
}

// Cancel kills the running script for appName, if any. It does not clean up
// any cloud resources the script may have already created before being
// killed — the DO droplet/app may need manual teardown afterward.
func Cancel(appName string) bool {
	runningMu.Lock()
	defer runningMu.Unlock()
	cmd, ok := runningCmds[appName]
	if !ok || cmd == nil || cmd.Process == nil {
		return false
	}
	_ = cmd.Process.Kill()
	return true
}

func run(appName, scriptPath string, args []string, env []string, label string, emit Emitter) error {
	if err := claim(appName); err != nil {
		emit.EmitExit(label+":exit", ExitInfo{AppName: appName, Code: -1, Err: err.Error()})
		return err
	}
	defer release(appName)

	cmd, err := platform.ScriptCommand(scriptPath, args, env)
	if err != nil {
		emit.EmitExit(label+":exit", ExitInfo{AppName: appName, Code: -1, Err: err.Error()})
		return err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		emit.EmitExit(label+":exit", ExitInfo{AppName: appName, Code: -1, Err: err.Error()})
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		emit.EmitExit(label+":exit", ExitInfo{AppName: appName, Code: -1, Err: err.Error()})
		return err
	}

	if err := cmd.Start(); err != nil {
		emit.EmitExit(label+":exit", ExitInfo{AppName: appName, Code: -1, Err: err.Error()})
		return err
	}

	runningMu.Lock()
	runningCmds[appName] = cmd
	runningMu.Unlock()

	var wg sync.WaitGroup
	wg.Add(2)
	go streamLines(stdout, "stdout", appName, label, emit, &wg)
	go streamLines(stderr, "stderr", appName, label, emit, &wg)
	wg.Wait()

	waitErr := cmd.Wait()

	exitInfo := ExitInfo{AppName: appName, Code: cmd.ProcessState.ExitCode()}
	if waitErr != nil {
		exitInfo.Err = waitErr.Error()
	}
	emit.EmitExit(label+":exit", exitInfo)
	return waitErr
}

// claim reserves appName as running, failing if it already has a run in
// flight (deploying/tearing down the same game twice at once isn't
// supported — different games are independent and don't hit this).
func claim(appName string) error {
	runningMu.Lock()
	defer runningMu.Unlock()
	if _, ok := runningCmds[appName]; ok {
		return fmt.Errorf("a run is already in progress for %s", appName)
	}
	runningCmds[appName] = nil // reserve the slot before the process exists
	return nil
}

func release(appName string) {
	runningMu.Lock()
	defer runningMu.Unlock()
	delete(runningCmds, appName)
}

func streamLines(r io.Reader, stream, appName, label string, emit Emitter, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		emit.EmitLog(label+":log", LogLine{AppName: appName, Stream: stream, Text: scanner.Text()})
	}
}
