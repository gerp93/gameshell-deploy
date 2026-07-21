//go:build !windows

package platform

import (
	"os"
	"os/exec"
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
