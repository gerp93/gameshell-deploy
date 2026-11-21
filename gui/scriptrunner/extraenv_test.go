package scriptrunner

import "testing"

func TestExtraEnvYAMLMatchesSQLShape(t *testing.T) {
	got, err := extraEnvYAML([]ExtraEnvVar{
		{Key: "TRACK_TIMELINE_YT_API_KEY", Value: `abc"def\ghi`},
		{Key: "TRACK_TIMELINE_ANTHROPIC_API_KEY", Value: "sk-test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "" +
		"  - key: TRACK_TIMELINE_YT_API_KEY\n" +
		"    scope: RUN_AND_BUILD_TIME\n" +
		"    value: \"abc\\\"def\\\\ghi\"\n" +
		"  - key: TRACK_TIMELINE_ANTHROPIC_API_KEY\n" +
		"    scope: RUN_AND_BUILD_TIME\n" +
		"    value: \"sk-test\"\n"
	if got != want {
		t.Fatalf("yaml mismatch\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestExtraEnvYAMLRejectsEmptyAndNewlines(t *testing.T) {
	if _, err := extraEnvYAML([]ExtraEnvVar{{Key: "FOO", Value: ""}}); err == nil {
		t.Fatal("expected error for empty value")
	}
	if _, err := extraEnvYAML([]ExtraEnvVar{{Key: "FOO", Value: "a\nb"}}); err == nil {
		t.Fatal("expected error for newline")
	}
	got, err := extraEnvYAML(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("empty input should yield empty yaml, got %q", got)
	}
}
