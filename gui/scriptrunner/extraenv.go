package scriptrunner

import (
	"fmt"
	"os"
	"strings"

	"gameshell-deploy-gui/platform"
)

// extraEnvYAML renders ExtraEnv as the same YAML shape SQL credentials use
// in templates/spec.yaml (two-space list under envs:). create.sh cats this
// file into the spec immediately before `  github:` — values never go through
// WSL `env KEY=VAL` argv, which is how API keys were getting dropped while
// DEPLOY_SQL_* (plain strings on CreateRequest) still made it.
func extraEnvYAML(vars []ExtraEnvVar) (string, error) {
	var b strings.Builder
	seen := map[string]struct{}{}
	for _, ev := range vars {
		key := strings.TrimSpace(ev.Key)
		if key == "" {
			continue
		}
		if !validExtraEnvName(key) {
			return "", fmt.Errorf("invalid extra env name: %s", key)
		}
		if strings.ContainsAny(ev.Value, "\n\r") {
			return "", fmt.Errorf("extra env %s contains a newline", key)
		}
		if ev.Value == "" {
			return "", fmt.Errorf("extra env %s is empty", key)
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		escaped := strings.ReplaceAll(ev.Value, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"`, `\"`)
		fmt.Fprintf(&b, "  - key: %s\n    scope: RUN_AND_BUILD_TIME\n    value: \"%s\"\n", key, escaped)
	}
	return b.String(), nil
}

func validExtraEnvName(name string) bool {
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

// writeExtraEnvYAMLFile writes extra env YAML to a 0600 tempfile and returns
// the host path (caller deletes it) plus the path create.sh will see (wslpath
// on Windows). Empty ExtraEnv returns "", "", nil.
func writeExtraEnvYAMLFile(vars []ExtraEnvVar) (hostPath, scriptPath string, err error) {
	body, err := extraEnvYAML(vars)
	if err != nil {
		return "", "", err
	}
	if body == "" {
		return "", "", nil
	}
	f, err := os.CreateTemp("", "gameshell-extra-env-*.yml")
	if err != nil {
		return "", "", err
	}
	path := f.Name()
	if _, err := f.WriteString(body); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", "", err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = os.Remove(path)
		return "", "", err
	}
	scriptPath, err = platform.ToScriptPath(path)
	if err != nil {
		_ = os.Remove(path)
		return "", "", err
	}
	return path, scriptPath, nil
}
