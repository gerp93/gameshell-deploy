# TODO

This app's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and its `REPO_SCOPE.md` entry for that). Just what's not built yet.

## Features

- GUI support for the `holocron` target (`gui/` was deliberately left alone). It would need: a Target choice on the Config tab that
  writes `TARGET`, `HOLOCRON_HOST_PORT`, `HOLOCRON_FUNNEL_PORT` and `HOLOCRON_BIND` into `deploy.conf` (and hides the droplet region/
  tier/ssh-key controls); no tier/region/ssh-key arguments for those games (the scripts ignore them but print a note); passing extra
  keys as environment variables (the target rejects `EXTRA_ENV_YAML_FILE`) or teaching `targets/holocron.sh` to read that file; a
  Funnel on/off/status button that runs `funnel.sh`; its "new code available" notice already works through `redeploy.sh --check`,
  which the target answers from the running container; and the Prerequisites tab should check `ssh` to the box instead of `doctl`.
- `./funnel.sh` could also set `tailscale serve` for a tailnet-only HTTPS address.

## Fixes

-
