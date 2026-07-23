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

If `deploy.conf` sets `GIT_UPSTREAM` (a fork's upstream repo, `owner/name`),
`create.sh` checks it for commits not yet in `GIT_REPO` and offers to push
them across before deploying — no local checkout of either repo is needed,
it fetches both directly by URL.

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
