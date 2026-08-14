# gameshell-deploy

Shared deployment tooling for [gameshell-framework](https://github.com/gerp93/gameshell-framework)
games. One source of truth for the create/restore and backup/delete process;
all game configs and backups live in this repo, decoupled from application code.

## Model

This repo is a **control plane and artifact store**: it holds the deployment
scripts, templates, and all per-game configuration and backup data. The generic
process lives here; nothing game-specific lives in the application repos.

- **Process** (here): `create.sh`, `delete.sh`, and the `templates/`
  (`spec.yaml`, `setup.sh`). No game names or game-specific values.
- **Config** (here): `games/{APP_NAME}/deploy.conf` — app name, env prefix, DB
  name, port, git repo. See [deploy.conf.template](deploy.conf.template).
- **Data** (here): `games/{APP_NAME}/backups/` directory of GPG-encrypted
  database dumps (`*.sql.gpg`). Backups are optional; if none exist, a fresh
  database is created and the app initializes the schema on startup.

## Prerequisites

- A [Digital Ocean](https://www.digitalocean.com/) account with your SSH key added.
- [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) installed,
  authenticated with a token generated with the following scope access:
  - app (full)
  - droplet (full)
  - ssh_key (read)

  ```bash
  doctl auth init -t $TOKEN
  ```
- `gpg` installed (backups are encrypted at rest).
- `jq` installed (optional) — lets `create.sh` pre-check which price tiers are
  actually available in the configured Digital Ocean region before asking;
  without it, this check is skipped and a bad tier/region combination only
  surfaces as a failure from `doctl` at create time.

## Usage

Database credentials are passed via the environment so one operator setup works for any game:

```bash
export DEPLOY_SQL_USER=...
export DEPLOY_SQL_PASSWORD=...

# create (restores the latest games/APP_NAME/backups/*.sql.gpg)
./create.sh timeline-trivia
./create.sh card-judge

# back up and tear down
./delete.sh timeline-trivia
./delete.sh card-judge
```

Just pass the app name; config and backups are read from `games/{APP_NAME}/`.

Restoring/creating a backup decrypts/encrypts it with `gpg`, which normally
prompts interactively for the passphrase — fine in a terminal. To run
non-interactively (e.g. from a GUI wrapper with no TTY for pinentry), set
`GPG_PASSPHRASE` too; both scripts then use `gpg --batch --passphrase-fd`
instead of prompting.

Both scripts also accept flags so GUI wrappers can drive them
non-interactively — `create.sh` takes `--ssh-key=NAME`, `--tier=1|2|3`, and
`--yes` (auto-confirms the fork-sync push); `delete.sh` takes
`--backup=yes|no`. Omit any of them and the matching interactive prompt runs
as normal.

If `deploy.conf` sets `GIT_UPSTREAM` (a fork's upstream repo, `owner/name`),
`create.sh` checks it for commits not yet in `GIT_REPO` and offers to push
them across before deploying — no local checkout of either repo is needed,
it fetches both directly by URL.

`GIT_BRANCH` selects which branch is deployed, and which one that fork-sync
compares and pushes. Leave it blank to use the repo's own default branch,
which `create.sh` detects rather than assuming `main`. A branch that doesn't
exist on the remote is caught before the droplet is created.

## How env vars line up

`ENV_VAR_PREFIX` in `deploy.conf` is the single value that keeps the app and its
deployment in sync. The app reads its database settings through
`database.SetEnvVarPrefix(ENV_VAR_PREFIX)` (in the game's `main.go`), and `create.sh`
injects DO app env vars with matching keys — `${ENV_VAR_PREFIX}_SQL_HOST`,
`_SQL_USER`, `_SQL_PASSWORD`, `_SQL_DATABASE`. Change it in one place.

## Notes

- The tracked templates are never mutated; `create.sh` renders them into temp
  files per run.
- Decrypted `*.sql` backups are git-ignored; `games/*/backups/` is git-ignored
  entirely (encrypted `*.sql.gpg` included) — only `games/*/deploy.conf` is
  tracked.
- Version numbers are tracked per game (each repo keeps its own
  `version_bump.sh` and README version line) — versioning is intentionally not
  centralized here.

## Standards

This repo (including the `gui/` desktop app — see [gui/README.md](gui/README.md))
follows the shared conventions in
[gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards): theming,
release/CI, self-update, and licensing all defer to that repo as the source
of truth. See its `README.md` for the full catalog and this repo's own
[TODO.md](TODO.md) for the product backlog (as opposed to standards
compliance, which is tracked in KVG_Standards' `REPO_SCOPE.md`).
