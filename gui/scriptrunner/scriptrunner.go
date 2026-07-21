// Package scriptrunner invokes create.sh/delete.sh non-interactively (via
// their --ssh-key/--tier/--yes/--backup flags) and streams their stdout and
// stderr line-by-line to a caller-supplied Emitter.
package scriptrunner

import (
	"bufio"
	"bytes"
	"io"
	"path/filepath"
	"sync"

	"gameshell-deploy-gui/platform"
)

// LogLine is one line of a running script's stdout or stderr.
type LogLine struct {
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

// ExitInfo reports how a script run finished.
type ExitInfo struct {
	Code int    `json:"code"`
	Err  string `json:"err,omitempty"`
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
	OpsDir      string `json:"opsDir"`
	GameRepoDir string `json:"gameRepoDir"`
	SSHKeyName  string `json:"sshKeyName"`
	Tier        string `json:"tier"`
	AutoYes     bool   `json:"autoYes"`
	SQLUser     string `json:"sqlUser"`
	SQLPassword string `json:"sqlPassword"`
}

// DeleteRequest mirrors delete.sh's positional arg + flag. Backup is
// "yes" or "no" — matching --backup=yes|no; leave empty to fall back to
// delete.sh's own interactive prompt (not used by the GUI, but supported
// for completeness).
type DeleteRequest struct {
	OpsDir      string `json:"opsDir"`
	GameRepoDir string `json:"gameRepoDir"`
	Backup      string `json:"backup"`
}

var (
	runningMu  sync.Mutex
	runningCmd platform.Cmd
)

// RunCreate runs create.sh to completion, streaming output via emit under
// the "create:log" / "create:exit" events.
func RunCreate(req CreateRequest, emit Emitter) error {
	args := []string{req.GameRepoDir}
	if req.SSHKeyName != "" {
		args = append(args, "--ssh-key="+req.SSHKeyName)
	}
	if req.Tier != "" {
		args = append(args, "--tier="+req.Tier)
	}
	if req.AutoYes {
		args = append(args, "--yes")
	}
	env := []string{
		"DEPLOY_SQL_USER=" + req.SQLUser,
		"DEPLOY_SQL_PASSWORD=" + req.SQLPassword,
	}
	scriptPath := filepath.Join(req.OpsDir, "create.sh")
	return run(scriptPath, args, env, "create", emit)
}

// RunDelete runs delete.sh to completion, streaming output via emit under
// the "delete:log" / "delete:exit" events.
func RunDelete(req DeleteRequest, emit Emitter) error {
	args := []string{req.GameRepoDir}
	if req.Backup != "" {
		args = append(args, "--backup="+req.Backup)
	}
	scriptPath := filepath.Join(req.OpsDir, "delete.sh")
	return run(scriptPath, args, nil, "delete", emit)
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

// Cancel kills the currently running script, if any. It does not clean up
// any cloud resources the script may have already created before being
// killed — the DO droplet/app may need manual teardown afterward.
func Cancel() bool {
	runningMu.Lock()
	defer runningMu.Unlock()
	if runningCmd == nil || runningCmd.Process == nil {
		return false
	}
	_ = runningCmd.Process.Kill()
	return true
}

func run(scriptPath string, args []string, env []string, label string, emit Emitter) error {
	cmd, err := platform.ScriptCommand(scriptPath, args, env)
	if err != nil {
		emit.EmitExit(label+":exit", ExitInfo{Code: -1, Err: err.Error()})
		return err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		emit.EmitExit(label+":exit", ExitInfo{Code: -1, Err: err.Error()})
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		emit.EmitExit(label+":exit", ExitInfo{Code: -1, Err: err.Error()})
		return err
	}

	if err := cmd.Start(); err != nil {
		emit.EmitExit(label+":exit", ExitInfo{Code: -1, Err: err.Error()})
		return err
	}

	runningMu.Lock()
	runningCmd = cmd
	runningMu.Unlock()

	var wg sync.WaitGroup
	wg.Add(2)
	go streamLines(stdout, "stdout", label, emit, &wg)
	go streamLines(stderr, "stderr", label, emit, &wg)
	wg.Wait()

	waitErr := cmd.Wait()

	runningMu.Lock()
	runningCmd = nil
	runningMu.Unlock()

	exitInfo := ExitInfo{Code: cmd.ProcessState.ExitCode()}
	if waitErr != nil {
		exitInfo.Err = waitErr.Error()
	}
	emit.EmitExit(label+":exit", exitInfo)
	return waitErr
}

func streamLines(r io.Reader, stream, label string, emit Emitter, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		emit.EmitLog(label+":log", LogLine{Stream: stream, Text: scanner.Text()})
	}
}
