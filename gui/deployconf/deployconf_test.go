package deployconf

import (
	"os"
	"path/filepath"
	"testing"
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

func TestRawValueAndSavePreservesCheckLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deploy.conf")
	body := "APP_NAME=g\nSECRET_CHECK_YT_API_KEY=\"https://h/?key={KEY}|X-A: {KEY}\"\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := RawValue(path, "SECRET_CHECK_YT_API_KEY")
	if err != nil || got != "https://h/?key={KEY}|X-A: {KEY}" {
		t.Fatalf("RawValue = %q, %v", got, err)
	}

	conf, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	conf.AppName = "renamed"
	if err := Save(path, conf); err != nil {
		t.Fatal(err)
	}
	if got, _ := RawValue(path, "SECRET_CHECK_YT_API_KEY"); got != "https://h/?key={KEY}|X-A: {KEY}" {
		t.Fatalf("GUI save clobbered the check line: %q", got)
	}
}
