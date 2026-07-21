// Package deployconf reads and writes a game's games/APP_NAME/deploy.conf
// without disturbing its comments or key ordering — it rewrites only the
// values on recognized KEY= lines, leaving everything else (including
// examples/deploy.conf's documentation comments) untouched.
package deployconf

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// DeployConf mirrors the keys documented in examples/deploy.conf.
type DeployConf struct {
	AppName       string `json:"appName"`
	EnvPrefix     string `json:"envPrefix"`
	DBName        string `json:"dbName"`
	HTTPPort      string `json:"httpPort"`
	GitRepo       string `json:"gitRepo"`
	GitUpstream   string `json:"gitUpstream"`
	DropletRegion string `json:"dropletRegion"`
	DropletImage  string `json:"dropletImage"`
	DropletSize   string `json:"dropletSize"`
}

type field struct {
	key string
	get func(*DeployConf) *string
}

var fields = []field{
	{"APP_NAME", func(c *DeployConf) *string { return &c.AppName }},
	{"ENV_PREFIX", func(c *DeployConf) *string { return &c.EnvPrefix }},
	{"DB_NAME", func(c *DeployConf) *string { return &c.DBName }},
	{"HTTP_PORT", func(c *DeployConf) *string { return &c.HTTPPort }},
	{"GIT_REPO", func(c *DeployConf) *string { return &c.GitRepo }},
	{"GIT_UPSTREAM", func(c *DeployConf) *string { return &c.GitUpstream }},
	{"DROPLET_REGION", func(c *DeployConf) *string { return &c.DropletRegion }},
	{"DROPLET_IMAGE", func(c *DeployConf) *string { return &c.DropletImage }},
	{"DROPLET_SIZE", func(c *DeployConf) *string { return &c.DropletSize }},
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

// CreateFromTemplate copies templatePath (examples/deploy.conf) to destPath,
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
func Save(path string, conf DeployConf) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}

	var out []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		key, _, ok := parseLine(line)
		if ok {
			if fl := fieldByKey(key); fl != nil {
				line = key + "=" + *fl.get(&conf)
			}
		}
		out = append(out, line)
	}
	scanErr := scanner.Err()
	f.Close()
	if scanErr != nil {
		return scanErr
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

// Validate performs the same lightweight, non-authoritative checks the GUI
// form runs before a save — it exists to catch typos early, not to replace
// create.sh/delete.sh's own `:?` required-var checks, which remain the
// source of truth.
func Validate(conf DeployConf) []string {
	var errs []string
	requireNonEmpty(&errs, "APP_NAME", conf.AppName)
	requireNonEmpty(&errs, "ENV_PREFIX", conf.EnvPrefix)
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
	return errs
}

func requireNonEmpty(errs *[]string, name, value string) {
	if strings.TrimSpace(value) == "" {
		*errs = append(*errs, name+" is required")
	}
}
