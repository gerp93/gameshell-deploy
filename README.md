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
  name, port, git repo, optional extra env var names. See
  [deploy.conf.template](deploy.conf.template).
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

# ship new app code to a running instance (database droplet untouched)
./redeploy.sh timeline-trivia
./redeploy.sh card-judge
```

Just pass the app name; config and backups are read from `games/{APP_NAME}/`.

`redeploy.sh` is for new code, not infrastructure: it syncs the fork, warns if
the commits about to ship add destructive SQL (`DROP`, `DELETE`, `UPDATE`,
`TRUNCATE`, `MODIFY`/`CHANGE` column), takes a fresh encrypted backup of the
live database, then has App Platform build and roll out the latest commit.
The games apply their own idempotent schema migrations on startup, so the live
database is migrated in place; if the new build fails to start, the previous
one keeps serving. It does not re-render the app spec, so changed env vars
(SQL host, extra API keys) or app size need a teardown and create instead.
Flags: `--backup=yes|no`, `--ssh-key=NAME`, `--force-rebuild`, `--yes`.
`./redeploy.sh APP_NAME --check` is read-only: it reports whether the branch has
commits that aren't deployed yet (the GUI uses it to show a "new code
available" notice) and exits without prompting, backing up, or deploying.

Restoring/creating a backup decrypts/encrypts it with `gpg`, which normally
prompts interactively for the passphrase — fine in a terminal. To run
non-interactively (e.g. from a GUI wrapper with no TTY for pinentry), set
`GPG_PASSPHRASE` too; both scripts then use `gpg --batch --passphrase-fd`
instead of prompting.

Both scripts also accept flags so GUI wrappers can drive them
non-interactively — `create.sh` takes `--ssh-key=NAME`, `--tier=1|2|3`, and
`--yes` (auto-confirms the fork-sync push); `delete.sh` takes
`--backup=yes|no` and `--ssh-key=NAME` (which key to use for the
pre-teardown database backup). Skip-backup teardown never SSHes, so
`--ssh-key` is ignored when `--backup=no`. Both the interactive prompts
and the GUI dropdowns list only DigitalOcean keys that also exist on this
machine (`create.sh --list-ssh-keys`). Omit any of the flags and the
matching interactive prompt runs as normal.

If `deploy.conf` sets `GIT_UPSTREAM` (a fork's upstream repo, `owner/name`),
`create.sh` checks it for commits not yet in `GIT_REPO` and offers to push
them across before deploying — no local checkout of either repo is needed,
it fetches both directly by URL.

`GIT_BRANCH` selects which branch is deployed, and which one that fork-sync
compares and pushes. Leave it blank to use the repo's own default branch,
which `create.sh` detects rather than assuming `main`. A branch that doesn't
exist on the remote is caught before the droplet is created.

## Running on the home server instead of DigitalOcean (the "holocron" target)

A game's `deploy.conf` can set `TARGET=holocron` (see the commented block at the end of
[deploy.conf.template](deploy.conf.template)) to run on the always-on home server, a Debian box with Docker,
instead of DigitalOcean. The commands are the same (`./create.sh APP`, `./delete.sh APP`, `./redeploy.sh APP`),
with the same `games/APP/deploy.conf` and the same GPG-encrypted `backups/`; unset, `TARGET` defaults to DigitalOcean and
nothing about that path changes. The code is in [targets/holocron.sh](targets/holocron.sh).

- **Needs** (on the box): the shared MariaDB container from the [Holocron](https://github.com/gerp93/Holocron) repo
  (`sudo ./bootstrap.sh`, `services/mariadb/`), `git`, Docker, and passwordless `sudo` for the login user. On this PC: `ssh`
  access to the box with a key and `gpg`; no Docker and no `doctl`. The ssh target is never stored here: it is
  `HOLOCRON_SSH_TARGET`, or `DEPLOY_TARGET` from `~/.config/kvguzzler/deploy.env`.
- **create:** checks the box, makes one database and one user for the game in the shared MariaDB (the password is generated on the
  box into `/etc/holocron/games/APP.env`, mode 0600, never printed), restores the newest backup (decrypted here and piped in,
  never written to disk on this PC), clones the game's GitHub repo on the box, builds its own `Dockerfile` there at low priority
  (capped at 1 CPU so the house server is not starved) and starts the container `game_APP`, published on
  `HOLOCRON_BIND:HOLOCRON_HOST_PORT` (default `127.0.0.1` only). If any step fails, what was created is rolled back.
  No DigitalOcean account, tier, region or ssh key option applies (`--tier`, `--region`, `--ssh-key` are ignored).
- **delete:** same five-check dump as DigitalOcean (made on the box, streamed through `gpg` into `backups/`, then verified by
  decrypting it), then removes the container, images, sources, env file, database and user, and takes the game off Funnel if it
  was on it. If the backup fails nothing is removed.
- **redeploy:** fork-sync, the destructive-SQL warning, a live `--single-transaction` backup, then a rebuild on the box and a
  container swap (a few seconds of downtime). If the new container does not answer, the previous image is put back.
  `--check` reads the deployed commit from the container. Env vars (database host, extra API keys) are not re-written, as on
  DigitalOcean; delete and create again to change them.
- **Internet access:** a new game is private. `./funnel.sh APP on|off|status` publishes it through Tailscale Funnel on
  `HOLOCRON_FUNNEL_PORT`. Funnel only allows ports 443, 8443 and 10000 on the box's `.ts.net` name, so at most three games, one
  per port. Two account settings in the Tailscale admin console come first and are never changed by this tool: DNS > HTTPS
  Certificates, and an access-policy entry that allows Funnel for the box.
- The GUI (`gui/`) supports it too: pick **Home server** as the target on a game's Config tab (see [gui/README.md](gui/README.md)). It
  has the scripts use the Windows `ssh.exe`, since WSL has no key for the box, and passes API keys to `targets/holocron.sh` through
  the same temporary `EXTRA_ENV_YAML_FILE` it uses for DigitalOcean.

## How env vars line up

`ENV_VAR_PREFIX` in `deploy.conf` is the single value that keeps the app and its
deployment in sync. The app reads its database settings through
`database.SetEnvVarPrefix(ENV_VAR_PREFIX)` (in the game's `main.go`), and `create.sh`
injects DO app env vars with matching keys — `${ENV_VAR_PREFIX}_SQL_HOST`,
`_SQL_USER`, `_SQL_PASSWORD`, `_SQL_DATABASE`. Change it in one place.

Games that need additional secrets (API keys, etc.) list the env var **names**
in `deploy.conf`'s `EXTRA_ENV_VARS` (space- or comma-separated). Values stay in
the operator's environment and are copied onto the DO app at create time, same as
`DEPLOY_SQL_*`. A leading `+` concatenates `ENV_VAR_PREFIX`; unmarked names are
injected as-is:

```bash
# in games/my-game/deploy.conf (names only, safe to commit)
EXTRA_ENV_VARS="+OPENAI_API_KEY +OTHER_SECRET UNPREFIXED_KEY"

# in the operator's environment (values, never a file)
export MY_GAME_OPENAI_API_KEY=...
export MY_GAME_OTHER_SECRET=...
export UNPREFIXED_KEY=...
./create.sh my-game
```

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
