# gameshell-deploy GUI

A desktop app (Wails, Go) that wraps `create.sh`/`delete.sh` for operators
who prefer clicking a button over running them from a terminal. See the
`gui/` exception noted in [../CLAUDE.md](../CLAUDE.md) — this is the one
non-bash corner of the repo.

It does not reimplement any deploy logic: it shells out to the tracked
`create.sh`/`delete.sh` in a `gameshell-deploy` checkout you point it at,
using their `--ssh-key`/`--tier`/`--yes`/`--backup` flags to drive them
non-interactively, and streams their real stdout/stderr into a log pane.

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

## Layout

- `platform/` — OS-specific command building (native on macOS/Linux, via
  `wsl.exe` on Windows); everything else in this app is OS-agnostic.
- `scriptrunner/` — invokes `create.sh`/`delete.sh` and streams their output.
- `deployconf/` — reads/writes a game's `games/APP_NAME/deploy.conf` without
  disturbing its comments.
- `preflight/` — checks doctl/gpg/ssh (and WSL, on Windows) are present.
- `settings/` — persists the chosen ops-repo path and last-used app name
  (never secrets) outside the repo tree.
- `frontend/` — the UI (plain TypeScript + Vite, no framework).
