package secretcheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testKey = "sk-te/st+key"

func run(t *testing.T, handler http.HandlerFunc, specFor func(base string) string) Result {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	defer srv.Close()
	client := srv.Client()
	client.CheckRedirect = NewClient().CheckRedirect
	res := Check(context.Background(), client, specFor(srv.URL), testKey)
	if strings.Contains(res.Detail, testKey) {
		t.Fatalf("result leaked the key: %q", res.Detail)
	}
	return res
}

func TestOKSendsKeyInQueryAndHeader(t *testing.T) {
	var gotQuery, gotHeader, gotFixed string
	res := run(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("key")
		gotHeader = r.Header.Get("x-api-key")
		gotFixed = r.Header.Get("anthropic-version")
		w.WriteHeader(http.StatusOK)
	}, func(base string) string {
		return base + "/v1/models?key={KEY}|x-api-key: {KEY}|anthropic-version: 2023-06-01"
	})
	if res.Status != OK {
		t.Fatalf("status = %s (%s), want ok", res.Status, res.Detail)
	}
	if gotQuery != testKey || gotHeader != testKey || gotFixed != "2023-06-01" {
		t.Fatalf("server saw query=%q header=%q fixed=%q", gotQuery, gotHeader, gotFixed)
	}
}

func TestRejectedKeyIsInvalidAndRedacted(t *testing.T) {
	for _, code := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden} {
		res := run(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
			// Some APIs echo the offending key back in the error body.
			_, _ = w.Write([]byte(`{"error":"bad key ` + testKey + `"}`))
		}, func(base string) string { return base + "/?key={KEY}" })
		if res.Status != Invalid {
			t.Fatalf("HTTP %d: status = %s, want invalid", code, res.Status)
		}
		if !strings.Contains(res.Detail, "***") {
			t.Fatalf("HTTP %d: expected redacted body in %q", code, res.Detail)
		}
	}
}

func TestInconclusiveResponsesAreUnverifiedNotInvalid(t *testing.T) {
	cases := map[string]struct {
		code int
		body string
	}{
		"quota 403":    {http.StatusForbidden, `{"error":{"errors":[{"reason":"quotaExceeded"}]}}`},
		"rate limited": {http.StatusTooManyRequests, ""},
		"server error": {http.StatusBadGateway, ""},
		"wrong url":    {http.StatusNotFound, ""},
		"redirect":     {http.StatusFound, ""},
	}
	for name, tc := range cases {
		res := run(t, func(w http.ResponseWriter, r *http.Request) {
			if tc.code == http.StatusFound {
				w.Header().Set("Location", "https://example.invalid/?key="+testKey)
			}
			w.WriteHeader(tc.code)
			_, _ = w.Write([]byte(tc.body))
		}, func(base string) string { return base + "/?key={KEY}" })
		if res.Status != Unverified {
			t.Fatalf("%s: status = %s (%s), want unverified", name, res.Status, res.Detail)
		}
	}
}

func TestBadConfigIsUnverified(t *testing.T) {
	specs := map[string]string{
		"plain http":     "http://example.com/?key={KEY}",
		"no placeholder": "https://example.com/?key=abc",
		"bad header":     "https://example.com/?key={KEY}|not a header",
		"not a url":      "::not-a-url::{KEY}",
	}
	for name, spec := range specs {
		res := Check(context.Background(), NewClient(), spec, testKey)
		if res.Status != Unverified {
			t.Fatalf("%s: status = %s, want unverified", name, res.Status)
		}
	}
}

func TestEmptySpecIsNone(t *testing.T) {
	if res := Check(context.Background(), NewClient(), "  ", testKey); res.Status != None {
		t.Fatalf("status = %s, want none", res.Status)
	}
}

func TestUnreachableHostDoesNotLeakKey(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	base := srv.URL
	srv.Close() // nothing listening any more
	res := Check(context.Background(), NewClient(), base+"/?key={KEY}", testKey)
	if res.Status != Unverified {
		t.Fatalf("status = %s, want unverified", res.Status)
	}
	if strings.Contains(res.Detail, testKey) || strings.Contains(res.Detail, "te%2Fst") {
		t.Fatalf("error text leaked the key: %q", res.Detail)
	}
}
