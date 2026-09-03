// Package deployconf reads and writes a game's games/APP_NAME/deploy.conf
// without disturbing its comments or key ordering — it rewrites only the
// values on recognized KEY= lines, leaving everything else (including
// deploy.conf.template's documentation comments) untouched.
package deployconf

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// DeployConf mirrors the keys documented in deploy.conf.template.
type DeployConf struct {
	AppName       string `json:"appName"`
	EnvVarPrefix  string `json:"envVarPrefix"`
	DBName        string `json:"dbName"`
	HTTPPort      string `json:"httpPort"`
	GitRepo       string `json:"gitRepo"`
	GitUpstream   string `json:"gitUpstream"`
	GitBranch     string `json:"gitBranch"`
	DropletRegion string `json:"dropletRegion"`
	DropletImage  string `json:"dropletImage"`
	DropletSize   string `json:"dropletSize"`
	// ExtraEnvVars is a space-separated list of env var NAMES (not values)
	// copied from the operator's environment onto the DO app at create time.
	// A leading '+' means concat with ENV_VAR_PREFIX ("+YT_API_KEY" with
	// prefix TRACK_TIMELINE becomes TRACK_TIMELINE_YT_API_KEY). Commas are
	// treated as separators, same as spaces.
	ExtraEnvVars string `json:"extraEnvVars"`
}

type field struct {
	key string
	get func(*DeployConf) *string
}

var fields = []field{
	{"APP_NAME", func(c *DeployConf) *string { return &c.AppName }},
	{"ENV_VAR_PREFIX", func(c *DeployConf) *string { return &c.EnvVarPrefix }},
	{"DB_NAME", func(c *DeployConf) *string { return &c.DBName }},
	{"HTTP_PORT", func(c *DeployConf) *string { return &c.HTTPPort }},
	{"GIT_REPO", func(c *DeployConf) *string { return &c.GitRepo }},
	{"GIT_UPSTREAM", func(c *DeployConf) *string { return &c.GitUpstream }},
	{"GIT_BRANCH", func(c *DeployConf) *string { return &c.GitBranch }},
	{"DROPLET_REGION", func(c *DeployConf) *string { return &c.DropletRegion }},
	{"DROPLET_IMAGE", func(c *DeployConf) *string { return &c.DropletImage }},
	{"DROPLET_SIZE", func(c *DeployConf) *string { return &c.DropletSize }},
	{"EXTRA_ENV_VARS", func(c *DeployConf) *string { return &c.ExtraEnvVars }},
}

func fieldByKey(key string) *field {
	for i := range fields {
		if fields[i].key == key {
			return &fields[i]
		}
	}
	return nil
}

// Exists reports whether path exists.
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Load parses path into a DeployConf. Only recognized keys are read; any
// other lines (comments, blanks, unknown keys) are ignored here — Save is
// what preserves them.
func Load(path string) (DeployConf, error) {
	f, err := os.Open(path)
	if err != nil {
		return DeployConf{}, err
	}
	defer f.Close()

	var conf DeployConf
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		key, value, ok := parseLine(scanner.Text())
		if !ok {
			continue
		}
		if fl := fieldByKey(key); fl != nil {
			*fl.get(&conf) = value
		}
	}
	return conf, scanner.Err()
}

// CreateFromTemplate copies templatePath (deploy.conf.template) to destPath,
// only if destPath doesn't already exist.
func CreateFromTemplate(templatePath, destPath string) error {
	if Exists(destPath) {
		return fmt.Errorf("deploy.conf already exists at %s", destPath)
	}
	data, err := os.ReadFile(templatePath)
	if err != nil {
		return err
	}
	return os.WriteFile(destPath, data, 0o644)
}

// Save rewrites only the value on each recognized KEY= line in path,
// leaving comments, blank lines, and unrecognized lines untouched. path
// must already exist (create it first via CreateFromTemplate).
//
// Recognized keys that weren't in the file yet (e.g. EXTRA_ENV_VARS on an
// older deploy.conf) are appended when their value is non-empty, so a GUI
// save can introduce them without requiring a hand-edit. Empty optional
// values are not appended, so a short existing conf doesn't grow blanks.
func Save(path string, conf DeployConf) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}

	var out []string
	seen := map[string]bool{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		key, _, ok := parseLine(line)
		if ok {
			if fl := fieldByKey(key); fl != nil {
				line = key + "=" + *fl.get(&conf)
				seen[key] = true
			}
		}
		out = append(out, line)
	}
	scanErr := scanner.Err()
	f.Close()
	if scanErr != nil {
		return scanErr
	}

	for _, fl := range fields {
		if seen[fl.key] {
			continue
		}
		if v := *fl.get(&conf); v != "" {
			out = append(out, fl.key+"="+v)
		}
	}

	return os.WriteFile(path, []byte(strings.Join(out, "\n")+"\n"), 0o644)
}

// parseLine extracts KEY and VALUE from a "KEY=VALUE" line. Comment and
// blank lines return ok=false.
func parseLine(line string) (key, value string, ok bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return "", "", false
	}
	idx := strings.Index(trimmed, "=")
	if idx < 0 {
		return "", "", false
	}
	return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+1:]), true
}

var gitRepoPattern = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
var envVarNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Validate performs the same lightweight, non-authoritative checks the GUI
// form runs before a save — it exists to catch typos early, not to replace
// create.sh/delete.sh's own `:?` required-var checks, which remain the
// source of truth.
func Validate(conf DeployConf) []string {
	var errs []string
	requireNonEmpty(&errs, "APP_NAME", conf.AppName)
	requireNonEmpty(&errs, "ENV_VAR_PREFIX", conf.EnvVarPrefix)
	requireNonEmpty(&errs, "DB_NAME", conf.DBName)
	requireNonEmpty(&errs, "HTTP_PORT", conf.HTTPPort)
	requireNonEmpty(&errs, "GIT_REPO", conf.GitRepo)

	if conf.HTTPPort != "" {
		if _, err := strconv.Atoi(conf.HTTPPort); err != nil {
			errs = append(errs, "HTTP_PORT must be numeric")
		}
	}
	if conf.GitRepo != "" && !gitRepoPattern.MatchString(conf.GitRepo) {
		errs = append(errs, "GIT_REPO must look like owner/name")
	}
	for _, tok := range extraEnvTokens(conf.ExtraEnvVars) {
		name, concatPrefix, ok := parseExtraEnvToken(tok)
		if !ok || !envVarNamePattern.MatchString(name) {
			errs = append(errs, "EXTRA_ENV_VARS contains an invalid name: "+tok)
			continue
		}
		if concatPrefix {
			resolved := conf.EnvVarPrefix + "_" + name
			if !envVarNamePattern.MatchString(resolved) {
				errs = append(errs, "EXTRA_ENV_VARS concatenates to an invalid name: "+resolved)
			}
		}
	}
	return errs
}

// extraEnvTokens splits EXTRA_ENV_VARS on whitespace and commas so a pasted
// "A, B" list isn't one token ending in a comma.
func extraEnvTokens(raw string) []string {
	return strings.Fields(strings.ReplaceAll(raw, ",", " "))
}

// parseExtraEnvToken reads one EXTRA_ENV_VARS token. A leading '+' means
// concat with ENV_VAR_PREFIX; the rest is the name.
func parseExtraEnvToken(tok string) (name string, concatPrefix bool, ok bool) {
	if strings.HasPrefix(tok, "+") {
		name = strings.TrimPrefix(tok, "+")
		return name, true, name != ""
	}
	return tok, false, tok != ""
}

func requireNonEmpty(errs *[]string, name, value string) {
	if strings.TrimSpace(value) == "" {
		*errs = append(*errs, name+" is required")
	}
}
