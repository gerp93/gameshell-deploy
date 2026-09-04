//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"syscall"
	"time"
)

type ghReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type ghRelease struct {
	TagName string           `json:"tag_name"`
	Assets  []ghReleaseAsset `json:"assets"`
}

// tryWindowsInstallerUpdate downloads `{app}-{tag}-windows-setup.exe` when
// attached to the latest GitHub release and runs it silently. Inno [Run]
// relaunches; this process os.Exit's. Returns applied=false when the
// installer isn't on the release (zip fallback).
//
// This matches KVG_Standards kvgupdate's installer path. Once that commit
// is on GitHub, ApplyUpdate can call kvgupdate.DownloadAndRunInstaller
// instead.
func tryWindowsInstallerUpdate(repo, appName, currentVersion string) (applied bool, err error) {
	rel, err := fetchLatestRelease(repo)
	if err != nil {
		return false, err
	}
	if !updateVersionLess(currentVersion, rel.TagName) {
		return false, nil
	}
	want := fmt.Sprintf("%s-%s-windows-setup.exe", appName, rel.TagName)
	var url string
	for _, a := range rel.Assets {
		if a.Name == want {
			url = a.BrowserDownloadURL
			break
		}
	}
	if url == "" {
		return false, nil
	}

	path, err := downloadInstaller(url)
	if err != nil {
		return false, err
	}
	cmd := exec.Command(path,
		"/VERYSILENT",
		"/SUPPRESSMSGBOXES",
		"/NORESTART",
		"/FORCECLOSEAPPLICATIONS",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := cmd.Start(); err != nil {
		return false, err
	}
	os.Exit(0)
	return true, nil
}

func fetchLatestRelease(repo string) (*ghRelease, error) {
	api := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err := http.NewRequest(http.MethodGet, api, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d from %s", resp.StatusCode, api)
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, err
	}
	return &rel, nil
}

func downloadInstaller(url string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/octet-stream")
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected status %d downloading installer", resp.StatusCode)
	}
	tmp, err := os.CreateTemp("", "gameshell-deploy-*-windows-setup.exe")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return tmp.Name(), nil
}
