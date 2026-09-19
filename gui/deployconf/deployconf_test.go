package deployconf

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const (
	ytSpec        = "https://www.googleapis.com/youtube/v3/videos?part=id&id=abc&key={KEY}"
	anthropicSpec = "https://api.anthropic.com/v1/models|x-api-key: {KEY}|anthropic-version: 2023-06-01"
)

func TestSecretCheckKeyResolvesPrefixedAndPlainNames(t *testing.T) {
	conf := DeployConf{EnvVarPrefix: "TRACK_TIMELINE", ExtraEnvVars: "+YT_API_KEY, PLAIN_KEY"}

	cases := map[string]string{
		"TRACK_TIMELINE_YT_API_KEY": "SECRET_CHECK_YT_API_KEY",
		"PLAIN_KEY":                 "SECRET_CHECK_PLAIN_KEY",
	}
	for resolved, want := range cases {
		got, ok := SecretCheckKey(conf, resolved)
		if !ok || got != want {
			t.Fatalf("SecretCheckKey(%q) = %q, %v; want %q", resolved, got, ok, want)
		}
	}
	if _, ok := SecretCheckKey(conf, "NOT_LISTED"); ok {
		t.Fatal("unlisted name should not resolve")
	}
}

func writeConf(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "deploy.conf")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadReadsSecretChecks(t *testing.T) {
	path := writeConf(t, "APP_NAME=g\nEXTRA_ENV_VARS=\"+YT_API_KEY +ANTHROPIC_API_KEY\"\n"+
		"SECRET_CHECK_YT_API_KEY=\""+ytSpec+"\"\n"+
		"SECRET_CHECK_ANTHROPIC_API_KEY=\""+anthropicSpec+"\"\n")

	conf, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []SecretCheck{{"YT_API_KEY", ytSpec}, {"ANTHROPIC_API_KEY", anthropicSpec}}
	if len(conf.SecretChecks) != 2 || conf.SecretChecks[0] != want[0] || conf.SecretChecks[1] != want[1] {
		t.Fatalf("SecretChecks = %+v, want %+v", conf.SecretChecks, want)
	}
	if got, _ := RawValue(path, "SECRET_CHECK_YT_API_KEY"); got != ytSpec {
		t.Fatalf("RawValue = %q", got)
	}
}

func TestSaveWritesRewritesAndRemovesChecks(t *testing.T) {
	path := writeConf(t, "# keep me\nAPP_NAME=g\nEXTRA_ENV_VARS=\"+YT_API_KEY +ANTHROPIC_API_KEY\"\n"+
		"SECRET_CHECK_YT_API_KEY=\"https://old.example/?key={KEY}\"\n"+
		"SECRET_CHECK_GONE=\"https://gone.example/?key={KEY}\"\n")

	conf, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	// YT rewritten, ANTHROPIC newly added, GONE (no longer in the form) dropped.
	conf.SecretChecks = []SecretCheck{{"YT_API_KEY", ytSpec}, {"ANTHROPIC_API_KEY", anthropicSpec}}
	if err := Save(path, conf); err != nil {
		t.Fatal(err)
	}

	got, _ := Load(path)
	if len(got.SecretChecks) != 2 || got.SecretChecks[0].Spec != ytSpec || got.SecretChecks[1].Spec != anthropicSpec {
		t.Fatalf("after save: %+v", got.SecretChecks)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "# keep me") || strings.Contains(string(raw), "GONE") || strings.Contains(string(raw), "old.example") {
		t.Fatalf("unexpected file contents:\n%s", raw)
	}

	// Clearing a spec removes its line.
	got.SecretChecks[0].Spec = "  "
	if err := Save(path, got); err != nil {
		t.Fatal(err)
	}
	after, _ := Load(path)
	if len(after.SecretChecks) != 1 || after.SecretChecks[0].Name != "ANTHROPIC_API_KEY" {
		t.Fatalf("after clearing YT: %+v", after.SecretChecks)
	}
}

// create.sh sources deploy.conf, so a saved spec containing & and | must come
// back through bash intact rather than backgrounding a command.
func TestSavedChecksSurviveSourcingInBash(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	path := writeConf(t, "APP_NAME=g\nEXTRA_ENV_VARS=\"+YT_API_KEY +ANTHROPIC_API_KEY\"\n")
	conf, _ := Load(path)
	conf.SecretChecks = []SecretCheck{{"YT_API_KEY", ytSpec}, {"ANTHROPIC_API_KEY", anthropicSpec}}
	if err := Save(path, conf); err != nil {
		t.Fatal(err)
	}

	// Sourced by relative name from its own directory, with no positional
	// args. On Windows "bash" may be the Store/WSL launcher stub, which can
	// exit 0 without running anything, so first prove this bash can source a
	// file from the temp dir; if it can't, the result below would be noise.
	dir := filepath.Dir(path)
	run := func(file, script string) (string, error) {
		cmd := exec.Command(bash, "-c", "set -e; source ./"+file+"; "+script)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	if err := os.WriteFile(filepath.Join(dir, "probe.conf"), []byte("PROBE=ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := run("probe.conf", `printf %s "$PROBE"`); err != nil || got != "ok" {
		t.Skipf("bash %q can't source files from a temp dir here (got %q, err %v)", bash, got, err)
	}

	script := `printf '%s\n%s' "$SECRET_CHECK_YT_API_KEY" "$SECRET_CHECK_ANTHROPIC_API_KEY"`
	outStr, err := run(filepath.Base(path), script)
	out := []byte(outStr)
	if err != nil {
		t.Fatalf("bash failed: %v\n%s", err, out)
	}
	if string(out) != ytSpec+"\n"+anthropicSpec {
		t.Fatalf("bash saw:\n%s", out)
	}
}

func TestValidateChecksRejectsOrphansAndBadSpecs(t *testing.T) {
	base := DeployConf{
		AppName: "g", EnvVarPrefix: "G", DBName: "G", HTTPPort: "1", GitRepo: "o/n",
		ExtraEnvVars: "+YT_API_KEY",
	}

	ok := base
	ok.SecretChecks = []SecretCheck{{"YT_API_KEY", ytSpec}, {"YT_API_KEY", ""}}
	if errs := Validate(ok); len(errs) != 0 {
		t.Fatalf("valid conf rejected: %v", errs)
	}

	for name, sc := range map[string]SecretCheck{
		"orphan":   {"NOT_LISTED", ytSpec},
		"http":     {"YT_API_KEY", "http://example.com/?key={KEY}"},
		"no key":   {"YT_API_KEY", "https://example.com/?key=abc"},
		"bad head": {"YT_API_KEY", "https://example.com/{KEY}|nocolon"},
	} {
		bad := base
		bad.SecretChecks = []SecretCheck{sc}
		if errs := Validate(bad); len(errs) == 0 {
			t.Fatalf("%s: expected a validation error", name)
		}
	}
}
