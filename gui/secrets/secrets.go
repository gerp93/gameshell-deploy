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

// Bundle is the set of secrets the Deploy/Teardown panels can remember.
// ExtraEnv is keyed by the resolved env var name (e.g. TRACK_TIMELINE_YT_API_KEY).
type Bundle struct {
	SQLUser       string            `json:"sqlUser"`
	SQLPassword   string            `json:"sqlPassword"`
	GPGPassphrase string            `json:"gpgPassphrase"`
	ExtraEnv      map[string]string `json:"extraEnv"`
}

// Load reads stored secrets. Missing keyring items are empty strings, not
// errors — first run, or a keyring that has never been written, is normal.
// extraNames are the extra env var keys to look up for the current game.
func Load(extraNames []string) (Bundle, error) {
	b := Bundle{ExtraEnv: map[string]string{}}
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
			b.ExtraEnv[name] = val
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
	for name, val := range b.ExtraEnv {
		if !validExtraName(name) {
			continue
		}
		if err := setIfNonEmpty(extraPrefix+name, val); err != nil {
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
// any extraNames from the environment (and on Windows, from WSL too). Empty
// if unset — same names create.sh uses on the CLI.
func FromEnv(extraNames []string) Bundle {
	b := Bundle{ExtraEnv: map[string]string{}}
	b.SQLUser = platform.LookupEnv("DEPLOY_SQL_USER")
	b.SQLPassword = platform.LookupEnv("DEPLOY_SQL_PASSWORD")
	b.GPGPassphrase = platform.LookupEnv("GPG_PASSPHRASE")
	for _, name := range extraNames {
		if v := platform.LookupEnv(name); v != "" {
			b.ExtraEnv[name] = v
		}
	}
	return b
}

// Merge prefers non-empty fields from preferred, filling gaps from fallback.
func Merge(preferred, fallback Bundle) Bundle {
	out := fallback
	if out.ExtraEnv == nil {
		out.ExtraEnv = map[string]string{}
	} else {
		copied := make(map[string]string, len(out.ExtraEnv))
		for k, v := range out.ExtraEnv {
			copied[k] = v
		}
		out.ExtraEnv = copied
	}
	if preferred.SQLUser != "" {
		out.SQLUser = preferred.SQLUser
	}
	if preferred.SQLPassword != "" {
		out.SQLPassword = preferred.SQLPassword
	}
	if preferred.GPGPassphrase != "" {
		out.GPGPassphrase = preferred.GPGPassphrase
	}
	for k, v := range preferred.ExtraEnv {
		if v != "" {
			out.ExtraEnv[k] = v
		}
	}
	return out
}
