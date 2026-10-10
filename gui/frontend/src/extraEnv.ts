// EXTRA_ENV_VARS lives in deploy.conf as a single space-separated string
// (create.sh sources it as bash; the Go save path quotes it so spaces
// don't become extra commands). A leading '+' means concat with
// ENV_VAR_PREFIX at resolve time: "+YT_API_KEY" with prefix TRACK_TIMELINE
// becomes TRACK_TIMELINE_YT_API_KEY. Unmarked names are used as-is.
// Commas are treated as separators too, so a pasted "A, B" list isn't one
// invalid name ending in a comma.

export type ExtraEnvEntry = {
  name: string;
  concatPrefix: boolean;
};

export function parseExtraEnvVars(raw: string): ExtraEnvEntry[] {
  const tokens = raw.trim().split(/[\s,]+/).filter(Boolean);
  const entries: ExtraEnvEntry[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("+")) {
      const name = tok.slice(1);
      if (name) entries.push({ name, concatPrefix: true });
    } else {
      entries.push({ name: tok, concatPrefix: false });
    }
  }
  return entries;
}

export function serializeExtraEnvVars(entries: ExtraEnvEntry[]): string {
  return entries
    .filter((e) => e.name.trim() !== "")
    .map((e) => (e.concatPrefix ? "+" : "") + e.name.trim())
    .join(" ");
}

export function resolveExtraEnvName(entry: ExtraEnvEntry, prefix: string): string {
  const name = entry.name.trim();
  if (!name) return "";
  if (entry.concatPrefix && prefix.trim() !== "") {
    return prefix.trim() + "_" + name;
  }
  return name;
}

export function resolveExtraEnvNames(raw: string, prefix: string): string[] {
  return parseExtraEnvVars(raw)
    .map((e) => resolveExtraEnvName(e, prefix))
    .filter(Boolean);
}
