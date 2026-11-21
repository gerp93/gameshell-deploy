//go:build !windows

package platform

import (
	"os"
	"os/exec"
	"runtime"
)

const isWindows = false

func scriptCommand(scriptPath string, args []string, env []string) (Cmd, error) {
	cmdArgs := append([]string{scriptPath}, args...)
	cmd := exec.Command("bash", cmdArgs...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = nil
	return cmd, nil
}

func rawCommand(name string, args []string) (Cmd, error) {
	cmd := exec.Command(name, args...)
	cmd.Stdin = nil
	return cmd, nil
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func wslAvailable() bool {
	return true
}

func openFolder(path string) error {
	return exec.Command(desktopOpener(), path).Start()
}

func openURL(rawURL string) error {
	return exec.Command(desktopOpener(), rawURL).Start()
}

func desktopOpener() string {
	if runtime.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

func lookupEnv(name string) string {
	return os.Getenv(name)
}

func toScriptPath(path string) (string, error) {
	return path, nil
}
