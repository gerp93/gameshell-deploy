// Package holocron finds the home server ("holocron") a TARGET=holocron game
// runs on, and works out what the deploy scripts need in their environment to
// reach it. The scripts themselves (targets/holocron.sh) do all the work; this
// only tells them where the box is and which ssh to use.
//
// The address is never stored in this repo or in deploy.conf: it is
// HOLOCRON_SSH_TARGET from the environment, or DEPLOY_TARGET in
// ~/.config/kvguzzler/deploy.env on this computer.
package holocron

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"gameshell-deploy-gui/platform"
)

// targetPattern matches the same user@host shape targets/holocron.sh accepts.
var targetPattern = regexp.MustCompile(`^[A-Za-z0-9._@:-]+$`)

var (
	cacheMu      sync.Mutex
	cachedTarget string
)

// SSHTarget returns the box's ssh target (user@host). A successful lookup is
// remembered for the life of the app: finding it can spawn a WSL call, and the
// sidebar asks for every home-server game on a timer.
func SSHTarget() (string, error) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if cachedTarget != "" {
		return cachedTarget, nil
	}
	target, err := lookupSSHTarget()
	if err == nil {
		cachedTarget = target
	}
	return target, err
}

func lookupSSHTarget() (string, error) {
	target := strings.TrimSpace(platform.LookupEnv("HOLOCRON_SSH_TARGET"))
	if target == "" {
		target = readDeployTarget()
	}
	if target == "" {
		return "", fmt.Errorf("no address for the home server: set HOLOCRON_SSH_TARGET=user@host, or DEPLOY_TARGET in ~/.config/kvguzzler/deploy.env")
	}
	if !targetPattern.MatchString(target) || strings.HasPrefix(target, "-") {
		return "", fmt.Errorf("the home server's ssh target has characters that are not accepted")
	}
	return target, nil
}

// readDeployTarget reads DEPLOY_TARGET from ~/.config/kvguzzler/deploy.env on
// the host (the Windows profile on Windows, which is where the scripts inside
// WSL cannot see it). "" when the file or the key is missing.
func readDeployTarget() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".config", "kvguzzler", "deploy.env"))
	if err != nil {
		return ""
	}
	return ParseDeployTarget(string(data))
}

// ParseDeployTarget extracts DEPLOY_TARGET from the text of a deploy.env file.
func ParseDeployTarget(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimRight(line, "\r"))
		if !strings.HasPrefix(line, "DEPLOY_TARGET=") {
			continue
		}
		v := strings.TrimPrefix(line, "DEPLOY_TARGET=")
		return strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return ""
}

// Host is the address part of target (after the "@"), for building the URL a
// game is reachable at on the home network.
func Host(target string) string {
	if i := strings.LastIndex(target, "@"); i >= 0 {
		return target[i+1:]
	}
	return target
}

// SSHProgram is the ssh to run the scripts' remote commands with. On Windows
// the scripts run inside WSL, which has no key for the box, so they use the
// Windows OpenSSH client (the one with the PC's own keys and agent), which WSL
// can run directly; elsewhere it is the plain "ssh" on PATH.
func SSHProgram() (string, error) {
	if !platform.IsWindows() {
		return "ssh", nil
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	exe := filepath.Join(root, "System32", "OpenSSH", "ssh.exe")
	if _, err := os.Stat(exe); err != nil {
		return "", fmt.Errorf("the Windows OpenSSH client was not found at %s: install it (Settings > Optional features > OpenSSH Client)", exe)
	}
	return platform.ToScriptPath(exe)
}

// ScriptEnv is what a deploy script run for a TARGET=holocron game needs in its
// environment: the ssh target and the ssh program. KEY=VALUE pairs, in the
// form platform.ScriptCommand takes.
func ScriptEnv() ([]string, error) {
	target, err := SSHTarget()
	if err != nil {
		return nil, err
	}
	env := []string{"HOLOCRON_SSH_TARGET=" + target}
	if platform.IsWindows() {
		prog, err := SSHProgram()
		if err != nil {
			return nil, err
		}
		env = append(env, "HOLOCRON_SSH="+prog)
	}
	return env, nil
}
