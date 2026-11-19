# TODO

This app's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and its `REPO_SCOPE.md` entry for that). Just what's not built yet.

## Features

- Home-server (holocron) games in the GUI: the Config tab, Deploy, Manage, sidebar status, a per-game ssh check and a Funnel panel are
  done (see gui/README.md). Not done: the Funnel panel cannot yet say whether the two Tailscale admin-console switches are on before it
  tries; and `tailscale funnel ... off` / the `funnel.sh info` URL parsing have only been checked against the CLI's help, not on a
  machine with Funnel enabled.
- `./funnel.sh` could also set `tailscale serve` for a tailnet-only HTTPS address.

## Fixes

-
