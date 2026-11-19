#!/usr/bin/env bash
################################################################################
# Put a game running on the home server (TARGET=holocron) on the internet through
# Tailscale Funnel, take it off again, or show what Funnel serves right now.
#
# Usage:  ./funnel.sh APP_NAME on [--yes]
#         ./funnel.sh APP_NAME off
#         ./funnel.sh APP_NAME status
#   Funnel only allows ports 443, 8443 and 10000 on the box's .ts.net name, so
#   at most three games can be public, one each. deploy.conf's
#   HOLOCRON_FUNNEL_PORT says which port this game uses; the game itself stays
#   published on the box's own HOLOCRON_HOST_PORT and Funnel proxies to it.
#
#   create.sh never turns this on: a game is private until you run "on".
#   "on" asks for a yes first (--yes skips the question).
#
#   Before the first "on" two switches in the Tailscale admin console must be
#   on (they are account settings this tool never touches): DNS > HTTPS
#   Certificates, and the access policy must allow Funnel for the box (the
#   "funnel" node attribute). `tailscale funnel` prints a link when one is
#   missing.
################################################################################

set -e # exit on any command error

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"

AUTO_YES=0
APP_NAME_ARG=""
ACTION=""
for arg in "$@"; do
	case "$arg" in
		--yes) AUTO_YES=1 ;;
		-*)
			echo "Unknown option: $arg"
			exit 1
			;;
		on | off | status) ACTION="$arg" ;;
		*) APP_NAME_ARG="$arg" ;;
	esac
done
: "${APP_NAME_ARG:?Usage: ./funnel.sh APP_NAME on|off|status [--yes]}"
: "${ACTION:?Usage: ./funnel.sh APP_NAME on|off|status [--yes]}"
GAME_CONFIG_DIR="$OPS_DIR/games/$APP_NAME_ARG"

CONFIG_PATH="$GAME_CONFIG_DIR/deploy.conf"
if [ ! -f "$CONFIG_PATH" ]; then
	echo "Config not found: $CONFIG_PATH"
	exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG_PATH"

if [[ "${TARGET:-digitalocean}" != "holocron" ]]; then
	echo "$APP_NAME_ARG is not a holocron game (TARGET in $CONFIG_PATH). Funnel only applies to the home server."
	exit 1
fi

# shellcheck source=targets/holocron.sh
source "$OPS_DIR/targets/holocron.sh"
holocron_funnel "$ACTION"
