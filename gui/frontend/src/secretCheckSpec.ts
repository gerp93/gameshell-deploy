// A key check is stored in deploy.conf as one SECRET_CHECK_<NAME> value:
// "URL|Header: value|Header: value" (see gui/secretcheck). The Config tab edits
// it as a URL box plus a headers box with one "Name: value" per line, since
// asking an operator to hand-type '|' separators is how typos happen.

export function splitSpec(spec: string): { url: string; headers: string } {
  const [url, ...headers] = spec.split("|");
  return {
    url: (url ?? "").trim(),
    headers: headers
      .map((h) => h.trim())
      .filter(Boolean)
      .join("\n"),
  };
}

// An empty URL means "no check": the headers alone are meaningless.
export function joinSpec(url: string, headers: string): string {
  const trimmedURL = url.trim();
  if (!trimmedURL) return "";
  const lines = headers
    .split("\n")
    .map((h) => h.trim())
    .filter(Boolean);
  return [trimmedURL, ...lines].join("|");
}

// The host a check would send the key to, for display; "" if the URL isn't
// parseable yet (mid-typing).
export function specHost(spec: string): string {
  try {
    return new URL(splitSpec(spec).url.replace("{KEY}", "KEY")).host;
  } catch {
    return "";
  }
}
