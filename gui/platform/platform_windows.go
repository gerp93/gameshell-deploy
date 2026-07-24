//go:build windows

package platform

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

const isWindows = true

// createNoWindow is CREATE_NO_WINDOW. Every command this package runs on
// Windows goes through wsl.exe, which is a console app — without this flag
// each invocation flashes a console window on screen, and the GUI runs
// several per user action (tier checks, doctl lookups, path translation),
// so they'd pop up constantly during normal use.
const createNoWindow = 0x08000000

// hidden applies CREATE_NO_WINDOW to cmd and returns it, so callers can wrap
// an exec.Command(...) inline.
func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	return cmd
}

// wslPathTranslate converts a Windows path to its WSL equivalent via
// `wsl.exe wslpath -a`, rather than hand-rolling a C:\ -> /mnt/c/
// substitution, which breaks on non-default drive mounts.
//
// Every wsl.exe call in this file passes -e (--exec): without it, wsl.exe
// joins argv into one string and re-parses it through the distro's default
// shell before running it, which silently eats backslashes in any argument
// (backslash-before-letter is just a shell escape) — so a Windows path like
// C:\Users\... arrives on the Linux side as "C:Users...". -e runs the given
// argv directly, no shell re-parsing, so backslashes survive intact.
func wslPathTranslate(winPath string) (string, error) {
	out, err := hidden(exec.Command("wsl.exe", "-e", "wslpath", "-a", winPath)).Output()
	if err != nil {
		return "", fmt.Errorf("wslpath translation failed for %q: %w", winPath, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func scriptCommand(scriptPath string, args []string, env []string) (Cmd, error) {
	wslScriptPath, err := wslPathTranslate(scriptPath)
	if err != nil {
		return nil, err
	}

	// args are create.sh/delete.sh's APP_NAME positional arg plus flags
	// like --tier=1 — never filesystem paths, so no translation needed.

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
	cmdArgs = append(cmdArgs, args...)

	cmd := hidden(exec.Command("wsl.exe", append([]string{"-e"}, cmdArgs...)...))
	cmd.Stdin = nil
	return cmd, nil
}

func rawCommand(name string, args []string) (Cmd, error) {
	cmdArgs := append([]string{"-e", name}, args...)
	cmd := hidden(exec.Command("wsl.exe", cmdArgs...))
	cmd.Stdin = nil
	return cmd, nil
}

func lookPath(name string) bool {
	err := hidden(exec.Command("wsl.exe", "-e", "which", name)).Run()
	return err == nil
}

func wslAvailable() bool {
	if _, err := exec.LookPath("wsl.exe"); err != nil {
		return false
	}
	return hidden(exec.Command("wsl.exe", "--status")).Run() == nil
}

// openFolder runs directly on Windows (not through wsl.exe) since path is
// already a native Windows path. explorer.exe often exits non-zero even on
// a successful open, so this only reports a launch failure, not its exit
// code.
func openFolder(path string) error {
	return exec.Command("explorer.exe", path).Start()
}
