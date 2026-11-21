// Package settings persists the operator's last selected app name, UI
// theme, and the "remember secrets" preference to a config file outside
// the repo tree — never any secrets.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Settings holds the non-secret preferences remembered between runs.
type Settings struct {
	LastAppName string `json:"lastAppName"`
	// Theme is a data-theme slug (see frontend/src/themes.css), or "" for
	// the default light/dark palette that follows the OS preference.
	Theme string `json:"theme"`
	// RememberSecrets is the Deploy/Teardown "save on this computer" checkbox.
	// The secrets themselves live in the OS keyring, not this file.
	RememberSecrets bool `json:"rememberSecrets"`
}

func path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gameshell-deploy-gui", "settings.json"), nil
}

// Load reads settings.json, returning a zero-value Settings (not an error)
// if it doesn't exist yet — e.g. on first run.
func Load() (Settings, error) {
	p, err := path()
	if err != nil {
		return Settings{}, err
	}
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return Settings{}, err
	}
	return s, nil
}

// Save writes settings.json, creating its parent directory if needed.
func Save(s Settings) error {
	p, err := path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}
