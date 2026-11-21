package scriptrunner

import (
	"reflect"
	"testing"
)

func TestParseRedeployCheckBehindWithSQL(t *testing.T) {
	out := "----------------------------------------\n" +
		"Found App: track-timeline (abc)\n" +
		"REDEPLOY_CHECK\tbehind\told123\tnew456\t17\tmain\t\r\n" +
		"REDEPLOY_CHECK_SQL\tsrc/a.sql: ALTER TABLE T DROP COLUMN X;\n" +
		"REDEPLOY_CHECK_SQL\tsrc/b.sql: DELETE T1\n"
	got, err := parseRedeployCheck(out)
	if err != nil {
		t.Fatal(err)
	}
	want := RedeployCheck{
		State:    RedeployBehind,
		Deployed: "old123",
		Latest:   "new456",
		Commits:  17,
		Branch:   "main",
		DestructiveSQL: []string{
			"src/a.sql: ALTER TABLE T DROP COLUMN X;",
			"src/b.sql: DELETE T1",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseRedeployCheckUnknownAndNoApp(t *testing.T) {
	got, err := parseRedeployCheck("REDEPLOY_CHECK\tunknown\t\tnew456\t\tmain\tcould not read the deployed commit\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != RedeployUnknown || got.Commits != -1 || got.Deployed != "" || got.Note == "" {
		t.Fatalf("unexpected unknown result: %+v", got)
	}
	if got.DestructiveSQL == nil || len(got.DestructiveSQL) != 0 {
		t.Fatalf("DestructiveSQL should be an empty non-nil slice, got %#v", got.DestructiveSQL)
	}

	got, err = parseRedeployCheck("REDEPLOY_CHECK\tno-app\t\t\t\t\t\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != RedeployNoApp || got.Commits != -1 {
		t.Fatalf("unexpected no-app result: %+v", got)
	}
}

func TestParseRedeployCheckRequiresResultLine(t *testing.T) {
	if _, err := parseRedeployCheck("Config not found: games/x/deploy.conf\n"); err == nil {
		t.Fatal("expected an error when the script printed no result line")
	}
}
