package scriptrunner

import "testing"

func TestParseHolocronInfo(t *testing.T) {
	out := "some noise\r\nHOLOCRON_INFO\trunning\tyes\t2026-11-18T23:50:00Z\tyes\thttps://box.tail.ts.net:8443\r\n"
	got, err := parseHolocronInfo(out)
	if err != nil {
		t.Fatal(err)
	}
	want := HolocronInfo{App: "running", Database: true, Created: "2026-11-18T23:50:00Z", Funnel: true, FunnelURL: "https://box.tail.ts.net:8443"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseHolocronInfoAbsentAndShortLines(t *testing.T) {
	got, err := parseHolocronInfo("HOLOCRON_INFO\tabsent\tno\t\tno\t\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.App != "absent" || got.Database || got.Funnel || got.Created != "" {
		t.Fatalf("unexpected: %+v", got)
	}
	if _, err := parseHolocronInfo("nothing useful\n"); err == nil {
		t.Fatal("expected an error when there is no HOLOCRON_INFO line")
	}
}
