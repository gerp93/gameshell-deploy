# gameshell-deploy GUI

A desktop app (Wails, Go) that wraps `create.sh`/`delete.sh` for operators
who prefer clicking a button over running them from a terminal. See the
`gui/` exception noted in [../CLAUDE.md](../CLAUDE.md) — this is the one
non-bash corner of the repo.

It does not reimplement any deploy logic: it shells out to the tracked
`create.sh`/`delete.sh` in the same checkout it's running from (auto-detected
from its own location — see `app.go`'s `GetOpsDir`), using their
`--ssh-key`/`--tier`/`--yes`/`--backup` flags to drive them non-interactively,
and streams their real stdout/stderr into a log pane. The deploy panel's
tier picker is likewise not reimplemented in Go — it calls
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
  `gpg`, `ssh`/`scp`. The app's Preflight panel checks for these at startup.
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
- `scriptrunner/` — invokes `create.sh`/`delete.sh` and streams their output.
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
