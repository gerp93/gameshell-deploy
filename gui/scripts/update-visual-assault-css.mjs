#!/usr/bin/env node
// Re-vendor the theme blocks in frontend/src/themes.css from a specific
// VisualAssault tag.
//
// Usage: node scripts/update-visual-assault-css.mjs v0.2.0
//
// VisualAssault's packages/css/themes.css defines each theme as a
// `body.<slug>-theme { --color-*: rgb(...); }` block. This app's
// frontend/src/themes.css instead uses `:root[data-theme="<slug>"]` with a
// different, narrower token set (see that file's header comment for the
// field mapping) plus "-rgb" companions for a few tokens (component CSS
// composites translucent tints from them). This script fetches
// VisualAssault's file at the given tag, remaps each theme block into this
// app's token shape, and splices the result in below the
// "VisualAssault vendored themes" marker — leaving the "Default"
// light/dark palette above it untouched, since that's this app's own, not
// VisualAssault's.
//
// Requires Node 18+ (global fetch) — same prerequisite gui/README.md
// already documents for building the app.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THEMES_CSS = path.join(__dirname, "..", "frontend", "src", "themes.css");
const MARKER = "/* --- VisualAssault vendored themes below --- */";

// Emit order matches the hand-authored file this script replaces (a
// cosmetic-only choice, but keeping it stable keeps re-vendor diffs
// minimal). Each entry is [destination custom property, VisualAssault
// field, isRgbCompanion] — an isRgbCompanion entry reuses the previous
// entry's value, expanded to a bare "r, g, b" triplet.
const FIELD_MAP = [
  ["--bg", "bg", false],
  ["--bg-hover", "bg-hover", false],
  ["--card-bg", "surface", false],
  ["--border", "border", false],
  ["--text", "text", false],
  ["--text-muted", "text-muted", false],
  ["--text-muted-rgb", "text-muted", true],
  ["--accent", "primary-action", false],
  ["--accent-hover", "primary-action-hover", false],
  ["--accent-rgb", "primary-action", true],
  ["--ok", "accent-green", false],
  ["--ok-rgb", "accent-green", true],
  ["--fail", "accent-red", false],
  ["--fail-rgb", "accent-red", true],
  ["--header-bg", "top-bar-bg", false],
  ["--header-hover", "top-bar-hover", false],
];

async function main() {
  const tag = process.argv[2];
  if (!tag) {
    console.error(`Usage: node ${path.basename(process.argv[1])} <visualassault-tag, e.g. v0.2.0>`);
    process.exit(1);
  }

  const url = `https://raw.githubusercontent.com/gerp93/VisualAssault/${tag}/packages/css/themes.css`;
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText} — check the tag exists`);
    process.exit(1);
  }
  const source = await res.text();

  const blockRe = /body\.([a-z0-9-]+)-theme\s*\{([^}]*)\}/g;
  const themes = [];
  let match;
  while ((match = blockRe.exec(source)) !== null) {
    const [, slug, body] = match;
    const fields = {};
    const fieldRe = /--color-([a-z-]+):\s*(rgb\([^)]+\));/g;
    let fieldMatch;
    while ((fieldMatch = fieldRe.exec(body)) !== null) {
      fields[fieldMatch[1]] = fieldMatch[2];
    }
    themes.push({ slug, fields });
  }

  if (themes.length === 0) {
    console.error("No `body.<slug>-theme` blocks found — VisualAssault's CSS shape may have changed; update FIELD_MAP/parsing above before re-running.");
    process.exit(1);
  }

  const blocks = themes.map(({ slug, fields }) => {
    const lines = [`:root[data-theme="${slug}"] {`];
    for (const [destProp, vaField, isRgbCompanion] of FIELD_MAP) {
      const value = fields[vaField];
      if (!value) {
        throw new Error(`Theme "${slug}" is missing VisualAssault field --color-${vaField} — aborting rather than emitting a partial theme.`);
      }
      if (isRgbCompanion) {
        const triplet = value.slice(value.indexOf("(") + 1, value.indexOf(")"));
        lines.push(`  ${destProp}: ${triplet};`);
      } else {
        lines.push(`  ${destProp}: ${value};`);
      }
    }
    lines.push("}");
    return lines.join("\n");
  });

  const current = readFileSync(THEMES_CSS, "utf8");
  const markerIndex = current.indexOf(MARKER);
  if (markerIndex === -1) {
    console.error(`Could not find marker comment (${JSON.stringify(MARKER)}) in ${THEMES_CSS} — add it above the vendored theme blocks before re-running.`);
    process.exit(1);
  }
  const before = current.slice(0, markerIndex + MARKER.length);

  const header = `\n/* Vendored verbatim (after token remapping — see this file's top comment)\n   from https://github.com/gerp93/VisualAssault packages/css/themes.css @ ${tag}.\n   Do not hand-edit these blocks; re-run scripts/update-visual-assault-css.mjs\n   against a newer VisualAssault tag instead, then commit the diff as its own\n   change so a version bump is reviewable on its own. */\n\n`;

  writeFileSync(THEMES_CSS, before + header + blocks.join("\n\n") + "\n");
  console.log(`Updated ${path.relative(process.cwd(), THEMES_CSS)} to VisualAssault ${tag} (${themes.length} themes). Review the diff, then commit.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
