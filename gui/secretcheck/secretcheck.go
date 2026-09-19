// Package secretcheck verifies an extra API key (EXTRA_ENV_VARS) against the
// service that issued it before a deploy, so a typo or revoked key fails in
// the GUI instead of surfacing after the app is already live.
//
// The request to make lives in deploy.conf, not here — this package knows
// nothing about any particular service. A check is one line:
//
//	SECRET_CHECK_YT_API_KEY="https://host/path?key={KEY}|Header-Name: {KEY}|Other: value"
//
// The first '|'-separated part is the URL (GET, https only); the rest are
// request headers. {KEY} is replaced with the secret — URL-escaped inside the
// URL, verbatim inside a header.
package secretcheck

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Status is the outcome of one check. Only Invalid should stop a deploy:
// Unverified means the service couldn't give a clear answer (network down,
// rate limited, 5xx), which says nothing about the key itself.
type Status string

const (
	OK         Status = "ok"
	Invalid    Status = "invalid"
	Unverified Status = "unverified"
	// None means deploy.conf has no check configured for this secret.
	None Status = "none"
)

type Result struct {
	Status Status `json:"status"`
	Detail string `json:"detail"`
	// Host is where the key was (or would have been) sent, so the UI can show
	// the operator exactly which server receives it.
	Host string `json:"host"`
}

const placeholder = "{KEY}"

// NewClient returns the client Check should normally use. Redirects are not
// followed: a redirect could carry the key (in a header or query string) to a
// host the operator never approved, so a 3xx is reported as unverified instead.
func NewClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// ValidateSpec reports whether spec is a usable check: an https:// URL, at
// least one {KEY} placeholder somewhere, and well-formed "Name: value"
// headers. An empty spec is valid (no check). Shared by Check and by the
// deploy.conf save path so a check that can never run is rejected on save.
func ValidateSpec(spec string) error {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil
	}
	parts := strings.Split(spec, "|")
	u, err := url.Parse(strings.ReplaceAll(strings.TrimSpace(parts[0]), placeholder, "KEY"))
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return errors.New("the check URL must be a valid https:// URL")
	}
	if !strings.Contains(spec, placeholder) {
		return errors.New("the check never uses " + placeholder + ", so it can't test a key")
	}
	for _, h := range parts[1:] {
		if _, _, ok := parseHeader(h); !ok {
			return fmt.Errorf("malformed header %q (expected \"Name: value\")", strings.TrimSpace(h))
		}
	}
	return nil
}

func parseHeader(h string) (name, value string, ok bool) {
	name, value, ok = strings.Cut(h, ":")
	name = strings.TrimSpace(name)
	return name, strings.TrimSpace(value), ok && name != ""
}

// Check runs spec (the value of a SECRET_CHECK_* line) with key substituted in.
// An empty spec yields None.
func Check(ctx context.Context, client *http.Client, spec, key string) Result {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return Result{Status: None}
	}
	if err := ValidateSpec(spec); err != nil {
		return Result{Status: Unverified, Detail: "Invalid key check: " + err.Error() + "."}
	}
	key = strings.TrimSpace(key)

	parts := strings.Split(spec, "|")
	u, err := url.Parse(strings.ReplaceAll(strings.TrimSpace(parts[0]), placeholder, url.QueryEscape(key)))
	if err != nil {
		return Result{Status: Unverified, Detail: "Invalid key check: the check URL isn't valid once the key is filled in."}
	}
	host := u.Host

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Result{Status: Unverified, Host: host, Detail: "Couldn't build the check request."}
	}
	for _, h := range parts[1:] {
		name, value, _ := parseHeader(h) // shape already checked by ValidateSpec
		req.Header.Set(name, strings.ReplaceAll(value, placeholder, key))
	}

	resp, err := client.Do(req)
	if err != nil {
		// A *url.Error message embeds the full request URL — including the key.
		return Result{Status: Unverified, Host: host, Detail: "Couldn't reach " + host + ": " + redact(errText(err), key)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	snippet := redact(errorSummary(body), key)

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return Result{Status: OK, Host: host, Detail: fmt.Sprintf("Accepted by %s (HTTP %d).", host, resp.StatusCode)}
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return Result{Status: Unverified, Host: host, Detail: fmt.Sprintf("%s is having trouble right now (HTTP %d) — couldn't verify the key.", host, resp.StatusCode)}
	case resp.StatusCode == http.StatusForbidden && looksLikeQuota(snippet):
		// Quota/rate errors are also 403 on some APIs (YouTube's quotaExceeded).
		// The key may be perfectly fine.
		return Result{Status: Unverified, Host: host, Detail: fmt.Sprintf("%s reports a quota or rate limit (HTTP 403) — couldn't verify the key. %s", host, snippet)}
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return Result{Status: Invalid, Host: host, Detail: strings.TrimSpace(fmt.Sprintf("%s rejected the key (HTTP %d). %s", host, resp.StatusCode, snippet))}
	default:
		return Result{Status: Unverified, Host: host, Detail: fmt.Sprintf("Unexpected HTTP %d from %s — check the SECRET_CHECK URL in deploy.conf.", resp.StatusCode, host)}
	}
}

// errText is the error message without the "Get \"<url>\": " wrapper, which
// only repeats the URL.
func errText(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

// redact removes the key (raw and URL-escaped) from text that came back from
// the network or from an error, so it can never be shown or logged.
func redact(text, key string) string {
	if key == "" {
		return text
	}
	text = strings.ReplaceAll(text, key, "***")
	return strings.ReplaceAll(text, url.QueryEscape(key), "***")
}

func looksLikeQuota(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "quota") || strings.Contains(lower, "rate limit") || strings.Contains(lower, "ratelimit")
}

// errorSummary turns an error response body into something short to show. Most
// APIs answer with JSON carrying a human message ({"error":{"message":...}},
// {"error":"..."}, {"message":"..."}); that message is far more useful than
// the raw blob. Anything else is shown flattened and truncated.
func errorSummary(body []byte) string {
	var doc struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(body, &doc) == nil {
		var nested struct {
			Message string `json:"message"`
		}
		var plain string
		switch {
		case json.Unmarshal(doc.Error, &nested) == nil && nested.Message != "":
			return collapse(nested.Message)
		case json.Unmarshal(doc.Error, &plain) == nil && plain != "":
			return collapse(plain)
		case doc.Message != "":
			return collapse(doc.Message)
		}
	}
	return collapse(string(body))
}

// collapse flattens a response body to one short line for display.
func collapse(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 200 {
		s = string(r[:200]) + "…"
	}
	return s
}
