//go:build windows

package platform

import (
	"fmt"
	"os/exec"
	"strings"
)

const isWindows = true

// wslPathTranslate converts a Windows path to its WSL equivalent via
// `wsl.exe wslpath -a`, rather than hand-rolling a C:\ -> /mnt/c/
// substitution, which breaks on non-default drive mounts.
func wslPathTranslate(winPath string) (string, error) {
	out, err := exec.Command("wsl.exe", "wslpath", "-a", winPath).Output()
	if err != nil {
		return "", fmt.Errorf("wslpath translation failed for %q: %w", winPath, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// translatePathArgs converts every non-flag argument (i.e. not starting
// with "-") to its WSL path equivalent; flag args like --tier=1 are passed
// through unchanged since their values are never filesystem paths.
func translatePathArgs(args []string) ([]string, error) {
	out := make([]string, len(args))
	for i, a := range args {
		if strings.HasPrefix(a, "-") {
			out[i] = a
			continue
		}
		translated, err := wslPathTranslate(a)
		if err != nil {
			return nil, err
		}
		out[i] = translated
	}
	return out, nil
}

func scriptCommand(scriptPath string, args []string, env []string) (Cmd, error) {
	wslScriptPath, err := wslPathTranslate(scriptPath)
	if err != nil {
		return nil, err
	}
	wslArgs, err := translatePathArgs(args)
	if err != nil {
		return nil, err
	}

	// Env vars don't cross the WSL process boundary automatically, so pass
	// them as a leading `env KEY=VAL` argv prefix to the inner bash call —
	// never by building a `bash -c "..."` string, which would both risk
	// shell-injection and be a quoting minefield for the password.
	var cmdArgs []string
	if len(env) > 0 {
		cmdArgs = append(cmdArgs, "env")
		cmdArgs = append(cmdArgs, env...)
	}
	cmdArgs = append(cmdArgs, "bash", wslScriptPath)
	cmdArgs = append(cmdArgs, wslArgs...)

	cmd := exec.Command("wsl.exe", cmdArgs...)
	cmd.Stdin = nil
	return cmd, nil
}

func rawCommand(name string, args []string) (Cmd, error) {
	cmdArgs := append([]string{name}, args...)
	cmd := exec.Command("wsl.exe", cmdArgs...)
	cmd.Stdin = nil
	return cmd, nil
}

func lookPath(name string) bool {
	err := exec.Command("wsl.exe", "which", name).Run()
	return err == nil
}

func wslAvailable() bool {
	if _, err := exec.LookPath("wsl.exe"); err != nil {
		return false
	}
	return exec.Command("wsl.exe", "--status").Run() == nil
}
