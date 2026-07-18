# gameshell-deploy

Shared deployment tooling for [gameshell-framework](https://github.com/gerp93/gameshell-framework)
games. One source of truth for the create/restore and backup/delete process;
each game repo contributes only its own config and database backups.

## Model

This repo is a **control plane**: you run its scripts and point them at a game
repo. The generic process lives here; the per-game values live in the game repo.

- **Process** (here): `create.sh`, `delete.sh`, and the `templates/`
  (`spec.yaml`, `setup.sh`). No game names or game-specific values.
- **Config** (in each game repo): a `deploy.conf` at the repo root — app name,
  env prefix, DB name, port, git repo. See [examples/deploy.conf](examples/deploy.conf).
- **Data** (in each game repo): a `backups/` directory of GPG-encrypted database
  dumps (`*.sql.gpg`).

## Prerequisites

- A [Digital Ocean](https://www.digitalocean.com/) account with your SSH key added.
- [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) installed
  and authenticated (`doctl auth init -t $TOKEN`), with app/droplet/ssh_key scopes.
- `gpg` installed (backups are encrypted at rest).

## Usage

Each game repo needs a `deploy.conf` (copy from `examples/deploy.conf`) and a
`backups/` directory. Database credentials are passed via the environment so one
operator setup works for any game:

```bash
export DEPLOY_SQL_USER=...
export DEPLOY_SQL_PASSWORD=...

# create (restores the latest backups/*.sql.gpg)
./create.sh /path/to/card-timeline

# back up and tear down
./delete.sh /path/to/card-timeline
```

If `GAME_REPO_DIR` is omitted it defaults to the current directory, so you can
also run these from inside a game repo:

```bash
cd /path/to/card-timeline
/path/to/gameshell-deploy/create.sh
```

## How env vars line up

`ENV_PREFIX` in `deploy.conf` is the single value that keeps the app and its
deployment in sync. The app reads its database settings through
`database.SetEnvPrefix(ENV_PREFIX)` (in the game's `main.go`), and `create.sh`
injects DO app env vars with matching keys — `${ENV_PREFIX}_SQL_HOST`,
`_SQL_USER`, `_SQL_PASSWORD`, `_SQL_DATABASE`. Change it in one place.

## Notes

- The tracked templates are never mutated; `create.sh` renders them into temp
  files per run.
- Decrypted `*.sql` backups are git-ignored here and should be in game repos too.
- Version numbers are tracked per game (each repo keeps its own
  `version_bump.sh` and README version line) — versioning is intentionally not
  centralized here.
