# CLAUDE.md — gameshell-deploy

Guidance for working in this repository. This file is a **style guide first,
an architecture map second**. Match the surrounding code; do not introduce
new styles, formatters, or abstractions.

## What this is

Shared deployment tooling for [gameshell-framework](https://github.com/gerp93/gameshell-framework)
games (currently [card-judge](https://github.com/gerp93/card-judge) and
[timeline-trivia](https://github.com/gerp93/timeline-trivia)). It is a
**control plane and artifact store**: you run its scripts from a checkout of
this repo, passing an app name (`./create.sh APP_NAME`); config and backups
for every game live in this repo too, under `games/APP_NAME/`. There is no
Go/JS/etc. code here — just bash scripts, a couple of templates, and docs.

Target platform: **Digital Ocean** (`doctl` for both a MariaDB droplet and a
DO App Platform app), driven from a **Linux/macOS shell** (`bash`). GPG
encrypts database backups at rest.

## The process/config/data split (must not blur)

- **Process** (this repo, generic): `create.sh`, `delete.sh`,
  `templates/setup.sh`, `templates/spec.yaml`. Fully generic — **no game
  names, no game-specific values, ever**. If you catch yourself hardcoding a
  game's name, env prefix, or port in these files, that value belongs in
  `games/APP_NAME/deploy.conf` instead.
- **Config** (this repo, per-game, tracked): `games/APP_NAME/deploy.conf`,
  copied from [deploy.conf.template](deploy.conf.template) — `APP_NAME`,
  `ENV_VAR_PREFIX`, `DB_NAME`, `HTTP_PORT`, `GIT_REPO`, optional `GIT_UPSTREAM`/
  droplet overrides. Only non-secret values live in `deploy.conf`, so it's
  safe to commit.
- **Data** (this repo, per-game, git-ignored): `games/APP_NAME/backups/`, a
  directory of GPG-encrypted database dumps (`*.sql.gpg`). The whole
  `backups/` directory is git-ignored (`games/*/backups/` in
  `.gitignore`) — encrypted dumps included, not just decrypted `*.sql` —
  because backups are operator-local working data, not shared tooling.
  Never commit a decrypted `*.sql` file regardless.
- **Secrets** come from the operator's environment, never from a file:
  `DEPLOY_SQL_USER` / `DEPLOY_SQL_PASSWORD` (used to create the MariaDB user
  on the droplet). Per-game secrets like `CARD_JUDGE_SQL_PASSWORD` are
  runtime env vars on the DO App, injected by `create.sh` from the operator's
  `DEPLOY_SQL_*` values — never written to a tracked file.
- **`GPG_PASSPHRASE`** (optional operator secret): backups are symmetric
  `gpg -c`/`gpg -d`, which normally prompts interactively via pinentry — fine
  for CLI use, but the GUI has no TTY for that. When set, `create.sh`/
  `delete.sh` pass it to gpg via `--batch --passphrase-fd` (never argv, never
  a file) instead of prompting; unset, both fall back to the interactive
  prompt exactly as before. Don't reintroduce a bare `gpg -c`/`gpg -d` call
  without this branch — it's the only thing keeping the GUI's fully
  non-interactive flow working.

`ENV_VAR_PREFIX` is the one value that has to match across repos: the game reads
its DB settings via `database.SetEnvVarPrefix(ENV_VAR_PREFIX)` in its own `main.go`
(gameshell-framework convention), and `create.sh` injects the DO app's env
vars using that same prefix (`${ENV_VAR_PREFIX}_SQL_HOST`, `_SQL_USER`, etc.).
Changing a game's `ENV_VAR_PREFIX` is a two-repo change.

`GIT_REPO`/`GIT_UPSTREAM` in `deploy.conf` are enough on their own to deploy
and fork-sync a game — DO App Platform clones `GIT_REPO` directly, and
`create.sh`'s fork-sync step fetches both remotes by URL into a throwaway
git dir. Neither needs a local checkout of the game repo anywhere in this
flow.

## Bash conventions (match these exactly)

- `#!/usr/bin/env bash` + `set -e` at the top of every script; a banner
  comment block (`###...`) explaining usage and the two env-var groups
  (operator secrets vs. `deploy.conf` values) precedes the code.
- Section dividers are `###`-lines (80 `#` chars) with a one-line comment
  underneath, not inline comments scattered through the logic.
- Required `deploy.conf` values are validated with bash's `:` + `${VAR:?msg}`
  idiom right after sourcing it (`: "${APP_NAME:?deploy.conf must set APP_NAME}"`),
  not hand-rolled `if [ -z ... ]` checks.
- Optional values get a `${VAR:-default}` fallback assigned once, near the
  required-value checks.
- `doctl ... --format=X --no-header | grep "$NAME" | cut -d ' ' -f 1` is the
  standing pattern for looking up a resource ID/IP by name — keep using it
  rather than switching to `--output json` + `jq` (this repo has no `jq`
  dependency; don't add one for a single lookup).
- Every destructive or slow step prints a `----...----` divider + a short
  present-participle status line ("Creating Droplet...", "Restoring
  Database...") before it runs, and a past-tense confirmation ("Droplet
  Created") after. Keep new steps consistent with that narration style.
- Long-running `doctl` calls poll with a bounded retry loop
  (`DONE_CHECKS_REMAINING`, `SSH_WAIT_REMAINING` style: decrement, `sleep`,
  bail with a clear message at zero) rather than an unbounded `while true`.
- Tracked templates (`templates/*.sh`, `templates/*.yaml`) are **never
  mutated in place** — `create.sh` renders them into `mktemp` files with
  `sed`, and a `trap 'rm -f ...' EXIT` cleans them up. If you add a new
  templated file, follow this same render-to-tempfile-then-clean-up pattern.
- Template placeholders are `REPLACE_<NAME>` (e.g. `REPLACE_APP_NAME`,
  `REPLACE_GIT_REPO`), substituted via `sed -e "s/REPLACE_X/${X}/g"`.
  **Use `sed`'s `|` delimiter (`s|REPLACE_GIT_REPO|${GIT_REPO}|g`), not `/`,
  for any value that can itself contain a `/`** (repo paths, URLs) — a `/`
  delimiter silently breaks on those values instead of erroring, which is
  exactly the kind of bug that only surfaces at deploy time. This bit us once
  with `GIT_REPO` (`owner/name`); don't reintroduce it elsewhere.
- Backup-file validation in `delete.sh` is defense-in-depth, not decoration:
  it checks the dump exists, is non-empty, was written in the last minute,
  is above a minimum size, and ends with MariaDB's `-- Dump completed on `
  trailer before it's trusted and GPG-encrypted. Keep all five checks if you
  touch that block — each one catches a different failure mode (SSH hiccup,
  disk full, truncated transfer, wrong DB name, mid-dump crash).
- `mariadb-dump` output is piped through `sed -e 's/DEFINER[ ]*=[ ]*[^*]*\*/\*/'`
  to strip `DEFINER=` clauses before the file is trusted — restoring a dump
  with a stale `DEFINER` onto a fresh droplet (no matching MariaDB user yet)
  fails; strip it at backup time, not restore time.

## CRLF safety (`.gitattributes`)

These scripts run on Linux (droplet user-data via `doctl`, SSH'd commands).
`.gitattributes` forces `*.sh`, `*.yaml`, and `deploy.conf` to LF regardless
of the checking-out platform so a Windows checkout never introduces CRLF that
breaks a shebang or a heredoc on the droplet. If you add a new script or
templated text file that ends up running on the droplet, add it to
`.gitattributes` too.

## Versioning

**Not centralized here on purpose.** Each consuming game repo tracks its own
version (own `version_bump.sh`, own README version line) — this repo has no
`version_bump.sh` and is not tagged in lockstep with any game. Don't add one
without discussing it first; the whole point of the split was per-repo
independence.

## Verify changes

There is no test suite (this is operational tooling against a real cloud
account). Verify by:
- Reading `create.sh`/`delete.sh` end-to-end after any `sed`/template change
  — a broken placeholder substitution fails silently (produces a spec with a
  literal `REPLACE_X` in it) rather than erroring.
- A dry run against `templates/setup.sh` / `templates/spec.yaml`: render them
  locally with the same `sed` calls the script uses and inspect the output
  for any leftover `REPLACE_` token before trusting a real `doctl apps
  create`/`droplet create` call.
- If you can safely afford it, an actual `create.sh`/`delete.sh` run against
  a throwaway `deploy.conf` is the real test — this tooling's failure mode is
  "half-created cloud resources," so prefer verifying against a real (if
  disposable) DO account over trusting a read-through alone.
