// Package platform builds *exec.Cmd values that run the same on macOS/Linux
// (directly) and on Windows (shelled through wsl.exe), so callers never
// branch on runtime.GOOS themselves.
package platform

import "os/exec"

// Cmd is the command type returned by this package — a plain *exec.Cmd,
// already configured to run on the current platform (natively, or via
// wsl.exe on Windows).
type Cmd = *exec.Cmd

// ScriptCommand returns a command that runs `bash scriptPath args...` with
// env appended to its environment. On Windows this shells through wsl.exe:
// scriptPath and any path-shaped positional args are translated to WSL
// paths, and env is passed as a leading `env KEY=VAL` argv prefix (env vars
// do not cross the WSL process boundary automatically).
func ScriptCommand(scriptPath string, args []string, env []string) (Cmd, error) {
	return scriptCommand(scriptPath, args, env)
}

// RawCommand returns a command that runs `name args...` directly (e.g.
// doctl, gpg, ssh, scp lookups), wrapped through wsl.exe on Windows.
func RawCommand(name string, args []string) (Cmd, error) {
	return rawCommand(name, args)
}

// LookPath reports whether name is available on PATH — inside WSL's
// default distro on Windows, on the host PATH elsewhere.
func LookPath(name string) bool {
	return lookPath(name)
}

// IsWindows reports whether the app is running on Windows, i.e. whether
// script/raw commands are being shelled through WSL.
func IsWindows() bool {
	return isWindows
}

// WSLAvailable reports whether wsl.exe itself is present and responsive.
// Always true on non-Windows platforms (the check is meaningless there).
func WSLAvailable() bool {
	return wslAvailable()
}

// OpenFolder opens path in the host's file manager (Explorer/Finder/xdg-open)
// — never through wsl.exe, since path is already a host-native path (this
// GUI, and the paths it deals with, always run on the host, not inside WSL).
func OpenFolder(path string) error {
	return openFolder(path)
}

// OpenURL opens rawURL in the host's default browser. Like OpenFolder this
// runs on the host, never through wsl.exe. Callers are responsible for
// validating the scheme first (see app.go's OpenURL).
func OpenURL(rawURL string) error {
	return openURL(rawURL)
}

// LookupEnv returns the value of name from the process environment. On
// Windows, if it isn't set on the host, it also checks the default WSL
// distro (login shell), so exports in ~/.bashrc match CLI use of create.sh.
// Names that aren't env-var identifiers return "".
func LookupEnv(name string) string {
	if !validEnvName(name) {
		return ""
	}
	return lookupEnv(name)
}

func validEnvName(name string) bool {
	if name == "" {
		return false
	}
	for i, c := range name {
		if c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			continue
		}
		if i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}
