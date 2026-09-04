//go:build !windows

package main

func tryWindowsInstallerUpdate(repo, appName, currentVersion string) (bool, error) {
	return false, nil
}
