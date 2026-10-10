# gameshell-deploy GUI

A desktop app (Wails, Go) that wraps `create.sh`/`delete.sh` for operators
who prefer clicking a button over running them from a terminal. See the
`gui/` exception noted in [../CLAUDE.md](../CLAUDE.md) — this is the one
non-bash corner of the repo.

It does not reimplement any deploy logic: it shells out to the tracked
`create.sh`/`delete.sh` in the same checkout it's running from (auto-detected
from its own location — see `app.go`'s `GetOpsDir`), using their
`--ssh-key`/`--tier`/`--yes`/`--backup` flags to drive them non-interactively,
and streams their real stdout/stderr into a log pane. The SSH key dropdowns
on Deploy and Teardown call `create.sh --list-ssh-keys` (see
`scriptrunner.ListSSHKeys`) so they only offer DigitalOcean keys that also
exist on this computer — a key that lives only on another PC cannot be
selected by accident. The deploy panel's tier picker is likewise not
reimplemented in Go — it calls
`create.sh APP_NAME --list-tiers` (see `scriptrunner.ListAvailableTiers`) to
run the same region-availability check create.sh itself runs before
deploying, so the two never drift apart on which tiers are actually
sellable in the configured region.

## Download

Prebuilt Windows, Linux, and macOS releases are published under
[Releases](https://github.com/gerp93/gameshell-deploy/releases) — download
the archive for your OS, extract it, and run `gameshell-deploy-gui`
(`.exe` on Windows) from wherever you extracted it. It needs the other
files in that archive alongside it: `create.sh`, `templates/`,
`deploy.conf.template`, `games/`. No Go/Node/Wails install needed to run it, only to build it
yourself (see below). New releases are built by
[`../.github/workflows/auto-release.yml`](../.github/workflows/auto-release.yml)
on every push to the default branch, or on demand via
[`../.github/workflows/cut-release.yml`](../.github/workflows/cut-release.yml)
— both call KVG_Standards'
[`release-go-gui.yml`](https://github.com/gerp93/KVG_Standards/blob/main/.github/workflows/release-go-gui.yml)
to do the actual build. On Linux/macOS you'll likely need to mark the
binary executable first: `chmod +x gameshell-deploy-gui`.

## Prerequisites

- Go 1.25+, Node 18+, and the [Wails CLI](https://wails.io/docs/gettingstarted/installation)
  (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`).
- Everything `create.sh`/`delete.sh` themselves need: `doctl` (authenticated),
  `gpg`, `ssh`/`scp`, `git`. The app's Preflight panel checks for these at startup,
  and also probes each game's `GIT_REPO`/`GIT_UPSTREAM` (and `GIT_BRANCH`) with the
  same `git ls-remote` create.sh uses, so an unreachable repo or typo'd branch shows
  up before a deploy.
  The header's "DO this month" readout (`doctl balance get`) is account-wide and
  needs a token with billing access; without it the readout just shows n/a.
- **On Windows**: [WSL](https://learn.microsoft.com/windows/wsl/install) with
  `doctl`/`gpg`/`ssh` installed inside it — the app shells every script
  invocation through `wsl.exe`.

## Development

```bash
cd gui
wails dev
```

## Building

```bash
cd gui
wails build
```

Produces a native binary under `gui/build/bin/`.

## Theming

`frontend/src/themes.css` is vendored from
[VisualAssault](https://github.com/gerp93/VisualAssault)'s
`packages/css/themes.css` at a pinned tag (see that file's header comment
for the current one and the token-name mapping). To bump it after a new
VisualAssault tag:

```bash
cd gui
node scripts/update-visual-assault-css.mjs v0.X.Y
```

This only regenerates the vendored block below the marker comment in
`themes.css`; the "Default" light/dark palette above it is this app's own
and is never touched. See KVG_Standards'
[themes-versioning.md](https://github.com/gerp93/KVG_Standards/blob/main/themes-versioning.md).

## Redeploying and the "new code available" notice

For a deployed game the Action tab is labelled **Manage** and offers
**Redeploy** (above Teardown). It runs `redeploy.sh`: sync the fork, back up
the live database, then have App Platform build and roll out the latest commit
of the branch — the database droplet is never touched. Redeploying doesn't
need new code; the panel works any time the game has a deployed app.

The app also checks proactively. When a game is selected, every 10 minutes,
and when the window regains focus, it runs `redeploy.sh APP_NAME --check`
(read-only: a `doctl apps get` plus a `git ls-remote`, and a fetch only when the
branch has moved). If the branch has commits that aren't deployed, a banner
appears above the tabs ("New code available on main: 3 new commits…") with a
**Review & redeploy** button; **Dismiss** hides it until an even newer commit.
Only the selected game is checked, not every game in the sidebar.

If those new commits add destructive SQL (`DROP`, `DELETE`, `UPDATE`,
`TRUNCATE`, `MODIFY`/`CHANGE`), the panel lists the lines and requires ticking
"I've reviewed these SQL changes" before Redeploy enables — the GUI always runs
the script with `--yes`, so this is where that warning is answered. As with
Deploy and Teardown, the run's settings (repo, branch, commit range, backup,
SSH key, secrets as ✓ set / ✗ not set…) are shown above the log.

## Status tags and uptime

Each game in the sidebar has a second line: **deployed**, **down**, or
**partial** (only the app or only the droplet exists — a deploy or teardown
that didn't finish, still billed), plus how long it has been up
(`deployed · 3h 12m`). While a script is running for the game, the tag and the
pill in the game header say **deploying…**, **redeploying…**, or **tearing
down…** instead of what Digital Ocean reports mid-job.

The uptime comes from Digital Ocean, not from anything the GUI remembers: the
earlier of the droplet's and the app's creation time (`doctl ... list -o json`).
So it is right for a game deployed from the CLI or another computer, and a
redeploy doesn't reset it. All games' tags come from one pair of `doctl` calls,
refreshed at startup, every 5 minutes, when the window regains focus, and after
a run finishes.

Set `MAX_UPTIME_HOURS` in a game's `deploy.conf` (Config tab; blank = no limit)
and the tag and header turn red with "over your Nh limit" once it has been up
longer. It is a reminder only — the GUI never tears anything down, and it can
only nudge you while it is open.

## Self-update

Wired via KVG_Standards'
[`packages/go/kvgupdate`](https://github.com/gerp93/KVG_Standards/tree/main/packages/go/kvgupdate)
(`App.CheckForUpdate`/`App.ApplyUpdate` in `app.go`, a "Check for Updates"
button in the header). Not yet verified end-to-end against a real tagged
release, and the running build currently has no way to know its own
version (see `appVersion`'s doc comment in `main.go`) — until
`release-go-gui.yml` is updated to stamp a version into the binary at
build time, `CheckForUpdate` will always report "up to date."

## Layout

- `platform/` — OS-specific command building (native on macOS/Linux, via
  `wsl.exe` on Windows); everything else in this app is OS-agnostic.
- `scriptrunner/` — invokes `create.sh`/`delete.sh`/`redeploy.sh` and streams
  their output; `redeploycheck.go` runs `redeploy.sh --check` and parses it.
- `deployconf/` — reads/writes a game's `games/APP_NAME/deploy.conf` without
  disturbing its comments.
- `preflight/` — checks doctl/gpg/ssh (and WSL, on Windows) are present.
- `settings/` — persists the last-used app name, UI theme, and the
  "remember secrets" preference (never the secrets themselves) outside
  the repo tree. The ops dir is never persisted — it's re-detected
  from the running executable's location every startup.
- `secrets/` — optional OS-keyring storage for SQL/API/GPG values the
  operator opted to remember (Windows Credential Manager, macOS Keychain,
  Linux Secret Service). Not the repo, not settings.json, not deploy.conf.
- `frontend/` — the UI (plain TypeScript + Vite, no framework).
