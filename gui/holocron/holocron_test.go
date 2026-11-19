package holocron

import "testing"

func TestParseDeployTarget(t *testing.T) {
	cases := map[string]string{
		"DEPLOY_TARGET=kvg@box.local\nHOUSED_TZ=America/Chicago\n": "kvg@box.local",
		"HOUSED_TZ=x\r\nDEPLOY_TARGET=\"kvg@10.0.0.5\"\r\n":        "kvg@10.0.0.5",
		"# DEPLOY_TARGET=nope\n":                                   "",
		"":                                                         "",
	}
	for in, want := range cases {
		if got := ParseDeployTarget(in); got != want {
			t.Errorf("ParseDeployTarget(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHost(t *testing.T) {
	if got := Host("kvg@box.local"); got != "box.local" {
		t.Errorf("Host = %q", got)
	}
	if got := Host("box.local"); got != "box.local" {
		t.Errorf("Host without user = %q", got)
	}
}
