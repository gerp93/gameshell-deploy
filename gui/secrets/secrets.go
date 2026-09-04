// Package secrets stores operator credentials in the OS keyring (Windows
// Credential Manager, macOS Keychain, Linux Secret Service) — never in
// settings.json, deploy.conf, or anything else that might be committed.
package secrets

import (
	"errors"
	"strings"

	"github.com/zalando/go-keyring"

	"gameshell-deploy-gui/platform"
)

const service = "gameshell-deploy-gui"

const (
	keySQLUser       = "sql-user"
	keySQLPassword   = "sql-password"
	keyGPGPassphrase = "gpg-passphrase"
	extraPrefix      = "extra:"
)

// ExtraEnvVar is one extra secret. A slice rather than map[string]string
// because Wails' generated TS models omit map fields, so maps never survive
// the frontend → Go round-trip (the same reason scriptrunner.CreateRequest
// uses a slice).
type ExtraEnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Bundle is the set of secrets the Deploy/Teardown panels can remember.
// ExtraEnv is keyed by the resolved env var name (e.g. TRACK_TIMELINE_YT_API_KEY).
type Bundle struct {
	SQLUser       string        `json:"sqlUser"`
	SQLPassword   string        `json:"sqlPassword"`
	GPGPassphrase string        `json:"gpgPassphrase"`
	ExtraEnv      []ExtraEnvVar `json:"extraEnv"`
}

// Load reads stored secrets. Missing keyring items are empty strings, not
// errors — first run, or a keyring that has never been written, is normal.
// extraNames are the extra env var keys to look up for the current game.
func Load(extraNames []string) (Bundle, error) {
	b := Bundle{}
	var err error
	if b.SQLUser, err = get(keySQLUser); err != nil {
		return Bundle{}, err
	}
	if b.SQLPassword, err = get(keySQLPassword); err != nil {
		return Bundle{}, err
	}
	if b.GPGPassphrase, err = get(keyGPGPassphrase); err != nil {
		return Bundle{}, err
	}
	for _, name := range extraNames {
		if !validExtraName(name) {
			continue
		}
		val, err := get(extraPrefix + name)
		if err != nil {
			return Bundle{}, err
		}
		if val != "" {
			b.ExtraEnv = append(b.ExtraEnv, ExtraEnvVar{Key: name, Value: val})
		}
	}
	return b, nil
}

// Save writes non-empty fields. Empty strings are skipped so a blank form
// field doesn't wipe a previously saved value; use Forget to clear.
func Save(b Bundle) error {
	if err := setIfNonEmpty(keySQLUser, b.SQLUser); err != nil {
		return err
	}
	if err := setIfNonEmpty(keySQLPassword, b.SQLPassword); err != nil {
		return err
	}
	if err := setIfNonEmpty(keyGPGPassphrase, b.GPGPassphrase); err != nil {
		return err
	}
	for _, ev := range b.ExtraEnv {
		if !validExtraName(ev.Key) {
			continue
		}
		if err := setIfNonEmpty(extraPrefix+ev.Key, ev.Value); err != nil {
			return err
		}
	}
	return nil
}

// Forget deletes SQL/GPG secrets and any extra names listed (typically the
// current game's EXTRA_ENV_VARS). Missing items are ignored.
func Forget(extraNames []string) error {
	for _, key := range []string{keySQLUser, keySQLPassword, keyGPGPassphrase} {
		if err := deleteKey(key); err != nil {
			return err
		}
	}
	for _, name := range extraNames {
		if !validExtraName(name) {
			continue
		}
		if err := deleteKey(extraPrefix + name); err != nil {
			return err
		}
	}
	return nil
}

func get(key string) (string, error) {
	val, err := keyring.Get(service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return val, err
}

func setIfNonEmpty(key, val string) error {
	if strings.TrimSpace(val) == "" {
		return nil
	}
	return keyring.Set(service, key, val)
}

func deleteKey(key string) error {
	err := keyring.Delete(service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

func validExtraName(name string) bool {
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

// FromEnv reads DEPLOY_SQL_USER / DEPLOY_SQL_PASSWORD / GPG_PASSPHRASE and
// any extraNames from the environment (and on Windows, the User-scope
// environment then WSL too). Empty if unset — same names create.sh uses
// on the CLI.
func FromEnv(extraNames []string) Bundle {
	b := Bundle{}
	b.SQLUser = platform.LookupEnv("DEPLOY_SQL_USER")
	b.SQLPassword = platform.LookupEnv("DEPLOY_SQL_PASSWORD")
	b.GPGPassphrase = platform.LookupEnv("GPG_PASSPHRASE")
	for _, name := range extraNames {
		if v := platform.LookupEnv(name); v != "" {
			b.ExtraEnv = append(b.ExtraEnv, ExtraEnvVar{Key: name, Value: v})
		}
	}
	return b
}

// Merge prefers non-empty fields from preferred, filling gaps from fallback.
func Merge(preferred, fallback Bundle) Bundle {
	out := fallback
	out.ExtraEnv = append([]ExtraEnvVar(nil), fallback.ExtraEnv...)
	if preferred.SQLUser != "" {
		out.SQLUser = preferred.SQLUser
	}
	if preferred.SQLPassword != "" {
		out.SQLPassword = preferred.SQLPassword
	}
	if preferred.GPGPassphrase != "" {
		out.GPGPassphrase = preferred.GPGPassphrase
	}
	byKey := map[string]int{}
	for i, ev := range out.ExtraEnv {
		byKey[ev.Key] = i
	}
	for _, ev := range preferred.ExtraEnv {
		if ev.Value == "" {
			continue
		}
		if i, ok := byKey[ev.Key]; ok {
			out.ExtraEnv[i] = ev
		} else {
			byKey[ev.Key] = len(out.ExtraEnv)
			out.ExtraEnv = append(out.ExtraEnv, ev)
		}
	}
	return out
}
