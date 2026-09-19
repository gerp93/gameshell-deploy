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

	"gameshell-deploy-gui/secretcheck"
)

// secretCheckPrefix starts the deploy.conf key of a pre-deploy key check:
// SECRET_CHECK_<NAME>, where NAME is the EXTRA_ENV_VARS entry without its '+'.
// See package secretcheck for the value format.
const secretCheckPrefix = "SECRET_CHECK_"

// SecretCheck is one pre-deploy key check. A slice on DeployConf rather than a
// map because Wails' generated TS models omit map fields.
type SecretCheck struct {
	// Name is the EXTRA_ENV_VARS entry without its '+' (e.g. YT_API_KEY).
	Name string `json:"name"`
	// Spec is the SECRET_CHECK_<Name> value: "URL|Header: value|...".
	Spec string `json:"spec"`
}

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
	// SecretChecks are the SECRET_CHECK_<NAME> lines, one per extra env var
	// that has a pre-deploy check. Saved back as those same lines.
	SecretChecks []SecretCheck `json:"secretChecks"`
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
		} else if name, isCheck := checkName(key); isCheck {
			conf.SecretChecks = append(conf.SecretChecks, SecretCheck{Name: name, Spec: value})
		}
	}
	return conf, scanner.Err()
}

// RawValue returns the value on the first KEY= line in path, whether or not
// KEY is one of the recognized fields — used for per-secret keys like
// SECRET_CHECK_YT_API_KEY that the form doesn't edit (Save leaves those lines
// untouched, so they survive a GUI save).
func RawValue(path, key string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		k, v, ok := parseLine(scanner.Text())
		if ok && k == key {
			return v, nil
		}
	}
	return "", scanner.Err()
}

// SecretCheckKey returns the deploy.conf key that holds the pre-deploy check
// for the extra secret whose resolved env var name is resolvedName (e.g.
// TRACK_TIMELINE_YT_API_KEY -> SECRET_CHECK_YT_API_KEY, named after the
// EXTRA_ENV_VARS entry as written, without its '+'). ok is false when
// resolvedName isn't one of conf's extra env vars.
func SecretCheckKey(conf DeployConf, resolvedName string) (key string, ok bool) {
	for _, tok := range extraEnvTokens(conf.ExtraEnvVars) {
		name, concatPrefix, valid := parseExtraEnvToken(tok)
		if !valid {
			continue
		}
		resolved := name
		if concatPrefix {
			resolved = conf.EnvVarPrefix + "_" + name
		}
		if resolved == resolvedName {
			return "SECRET_CHECK_" + name, true
		}
	}
	return "", false
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

	wantChecks := map[string]string{}
	for _, sc := range conf.SecretChecks {
		if strings.TrimSpace(sc.Spec) != "" {
			wantChecks[sc.Name] = strings.TrimSpace(sc.Spec)
		}
	}

	var out []string
	seen := map[string]bool{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		key, _, ok := parseLine(line)
		if ok {
			if fl := fieldByKey(key); fl != nil {
				line = key + "=" + writeValue(*fl.get(&conf))
				seen[key] = true
			} else if name, isCheck := checkName(key); isCheck {
				// The form owns every SECRET_CHECK_ line: rewrite the ones it
				// still has, and drop the ones it cleared or removed.
				spec, wanted := wantChecks[name]
				if !wanted || seen[key] {
					continue
				}
				line = key + "=" + writeValue(spec)
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
			out = append(out, fl.key+"="+writeValue(v))
		}
	}
	for _, sc := range conf.SecretChecks {
		key := secretCheckPrefix + sc.Name
		if spec, wanted := wantChecks[sc.Name]; wanted && !seen[key] {
			out = append(out, key+"="+writeValue(spec))
			seen[key] = true
		}
	}

	return os.WriteFile(path, []byte(strings.Join(out, "\n")+"\n"), 0o644)
}

// checkName returns NAME for a SECRET_CHECK_<NAME> key.
func checkName(key string) (string, bool) {
	name := strings.TrimPrefix(key, secretCheckPrefix)
	return name, name != key && name != ""
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
	return strings.TrimSpace(trimmed[:idx]), unquoteValue(strings.TrimSpace(trimmed[idx+1:])), true
}

// writeValue quotes a deploy.conf value when `source` would otherwise split
// it. Unquoted EXTRA_ENV_VARS=+A +B is parsed as EXTRA_ENV_VARS=+A and then
// a command named +B ("command not found"). Shell operators (& | ; < > ( ))
// count too: a SECRET_CHECK URL with "&id=..." left unquoted would background
// a command and drop the rest of the value.
func writeValue(v string) string {
	if v == "" || !strings.ContainsAny(v, " \t#'\"$`\\&|;<>()") {
		return v
	}
	escaped := strings.ReplaceAll(v, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	escaped = strings.ReplaceAll(escaped, `$`, `\$`)
	escaped = strings.ReplaceAll(escaped, "`", "\\`")
	return `"` + escaped + `"`
}

func unquoteValue(v string) string {
	n := len(v)
	if n < 2 {
		return v
	}
	if v[0] == '"' && v[n-1] == '"' {
		inner := v[1 : n-1]
		inner = strings.ReplaceAll(inner, `\"`, `"`)
		inner = strings.ReplaceAll(inner, `\$`, `$`)
		inner = strings.ReplaceAll(inner, "\\`", "`")
		inner = strings.ReplaceAll(inner, `\\`, `\`)
		return inner
	}
	if v[0] == '\'' && v[n-1] == '\'' {
		return v[1 : n-1]
	}
	return v
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
	errs = append(errs, validateSecretChecks(conf)...)
	return errs
}

// validateSecretChecks makes sure each check belongs to a listed extra env
// var (an orphan line would silently never run) and is a usable spec.
func validateSecretChecks(conf DeployConf) []string {
	var errs []string
	listed := map[string]bool{}
	for _, tok := range extraEnvTokens(conf.ExtraEnvVars) {
		if name, _, ok := parseExtraEnvToken(tok); ok {
			listed[name] = true
		}
	}
	for _, sc := range conf.SecretChecks {
		if strings.TrimSpace(sc.Spec) == "" {
			continue
		}
		if !envVarNamePattern.MatchString(sc.Name) || !listed[sc.Name] {
			errs = append(errs, "key check for "+sc.Name+" doesn't match any EXTRA_ENV_VARS entry")
			continue
		}
		if err := secretcheck.ValidateSpec(sc.Spec); err != nil {
			errs = append(errs, "key check for "+sc.Name+": "+err.Error())
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
