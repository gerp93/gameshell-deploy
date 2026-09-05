#!/usr/bin/env bash
################################################################################
# Back up and delete a Digital Ocean instance of a gameshell-framework game.
#
# Usage:  ./delete.sh APP_NAME [--backup=yes|no]
#   APP_NAME is the game name (e.g., timeline-trivia, card-judge). Config is
#   read from games/APP_NAME/deploy.conf. A new GPG-encrypted backup is
#   written into games/APP_NAME/backups before teardown (unless declined).
#
#   --backup=yes|no  skip the backup prompt, use this answer
#   This flag exists so GUI wrappers can drive this script non-interactively;
#   omit it and the backup prompt below still runs as normal.
#
# Operator secret (optional): GPG_PASSPHRASE encrypts the new backup
# non-interactively (--batch --passphrase-fd) instead of prompting via
# pinentry. Needed when driven from the GUI, which has no TTY for pinentry
# to use; omit it for normal interactive CLI use and gpg prompts as usual.
################################################################################

set -e # exit on any command error

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"

################################################################################
# check for new commits on this checkout's remote (never pulls automatically)
#
# This is gameshell-deploy's own git history, not the game's — bug fixes and
# behavior changes land here too, so a stale checkout can run with outdated
# logic. Only warns and confirms; never fetches destructively or merges.

echo "----------------------------------------"
if ! git -C "$OPS_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "Not a git checkout, skipping remote check."
elif ! git -C "$OPS_DIR" fetch --quiet 2>/dev/null; then
	echo "Could not fetch origin (offline?), skipping remote check."
elif ! git -C "$OPS_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
	echo "No upstream tracking branch configured for origin, skipping remote check."
else
	BEHIND_COUNT=$(git -C "$OPS_DIR" rev-list --count 'HEAD..@{u}')
	if [ "$BEHIND_COUNT" -gt 0 ]; then
		echo "This gameshell-deploy checkout is $BEHIND_COUNT commit(s) behind its remote:"
		git -C "$OPS_DIR" log --oneline 'HEAD..@{u}'
		read -p "Continue anyway without updating? (y/N): " CONFIRM_STALE
		if ! [[ "$CONFIRM_STALE" =~ ^[Yy]$ ]]; then
			echo "Aborted. Run 'git pull' in $OPS_DIR to update, then try again."
			exit 1
		fi
	else
		echo "This gameshell-deploy checkout is up to date with its remote."
	fi
fi

# If this gameshell-deploy checkout is itself a GitHub fork (has a
# conventional "upstream" remote), check that too — same fetch-only,
# never-pull, confirm pattern, just against the original repo instead of
# the fork. Unrelated to the game's own GIT_REPO/GIT_UPSTREAM fork-sync
# below — that's about the game being deployed, this is about this tool.
if ! git -C "$OPS_DIR" remote get-url upstream >/dev/null 2>&1; then
	echo "This gameshell-deploy checkout has no 'upstream' remote (not a fork), skipping upstream check."
elif ! git -C "$OPS_DIR" fetch --quiet upstream 2>/dev/null; then
	echo "Could not fetch this gameshell-deploy checkout's upstream (offline?), skipping upstream check."
else
	UPSTREAM_DEFAULT_BRANCH=$(git -C "$OPS_DIR" ls-remote --symref upstream HEAD | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#\1#p')
	if [ -z "$UPSTREAM_DEFAULT_BRANCH" ]; then
		echo "Could not determine this gameshell-deploy checkout's upstream default branch, skipping upstream check."
	else
		UPSTREAM_BEHIND_COUNT=$(git -C "$OPS_DIR" rev-list --count "HEAD..upstream/$UPSTREAM_DEFAULT_BRANCH")
		if [ "$UPSTREAM_BEHIND_COUNT" -gt 0 ]; then
			echo "This gameshell-deploy checkout is $UPSTREAM_BEHIND_COUNT commit(s) behind its upstream/$UPSTREAM_DEFAULT_BRANCH:"
			git -C "$OPS_DIR" log --oneline "HEAD..upstream/$UPSTREAM_DEFAULT_BRANCH"
			read -p "Continue anyway without syncing? (y/N): " CONFIRM_UPSTREAM_STALE
			if ! [[ "$CONFIRM_UPSTREAM_STALE" =~ ^[Yy]$ ]]; then
				echo "Aborted. Sync this gameshell-deploy checkout with upstream/$UPSTREAM_DEFAULT_BRANCH, then try again."
				exit 1
			fi
		else
			echo "This gameshell-deploy checkout is up to date with its upstream/$UPSTREAM_DEFAULT_BRANCH."
		fi
	fi
fi

################################################################################
# parse args

BACKUP_FLAG=""
APP_NAME_ARG=""
for arg in "$@"; do
	case "$arg" in
		--backup=*) BACKUP_FLAG="${arg#*=}" ;;
		-*)
			echo "Unknown option: $arg"
			exit 1
			;;
		*) APP_NAME_ARG="$arg" ;;
	esac
done
: "${APP_NAME_ARG:?Usage: ./delete.sh APP_NAME [--backup=yes|no]}"
GAME_CONFIG_DIR="$OPS_DIR/games/$APP_NAME_ARG"

################################################################################
# load per-game config

CONFIG_PATH="$GAME_CONFIG_DIR/deploy.conf"
if [ ! -f "$CONFIG_PATH" ]; then
	echo "Config not found: $CONFIG_PATH"
	exit 1
fi
# Unquoted EXTRA_ENV_VARS=+A +B is sourced as EXTRA_ENV_VARS=+A and then a
# command named +B. Catch that before source so it isn't "command not found".
if grep -Eq '^[[:space:]]*EXTRA_ENV_VARS=[^"'\''#].*[[:space:]]' "$CONFIG_PATH"; then
	echo "EXTRA_ENV_VARS in $CONFIG_PATH contains spaces but isn't quoted."
	echo "Use EXTRA_ENV_VARS=\"+NAME +OTHER\" or commas: EXTRA_ENV_VARS=+NAME,+OTHER"
	exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG_PATH"

: "${APP_NAME:?deploy.conf must set APP_NAME}"
: "${DB_NAME:?deploy.conf must set DB_NAME}"

DROPLET_NAME="$APP_NAME-database"
BACKUP_DIR="$GAME_CONFIG_DIR/backups"

################################################################################
# delete droplet

echo "----------------------------------------"
echo "Deleting Droplet..."

DROPLET_ID=$(doctl compute droplet list --format=ID,Name --no-header | grep "$DROPLET_NAME" | cut -d ' ' -f 1)
if [[ -z "$DROPLET_ID" ]]; then
	echo "Droplet ID not found"
else
	if [[ -n "$BACKUP_FLAG" ]]; then
		BACKUP_DB=$( [[ "$BACKUP_FLAG" == "no" ]] && echo "n" || echo "y" )
		echo "Backup database? $BACKUP_DB (from --backup)"
	else
		read -p "Do you want to backup the database? [Y/n]: " BACKUP_DB
	fi
	if [[ "$BACKUP_DB" != "n" ]]; then
		echo "----------------------------------------"
		echo "Backing Up Database..."

		BACKUP_SQL_PATH="$BACKUP_DIR/$(date +%Y%m%d%H%M%S)_backup_${APP_NAME}.sql"

		DROPLET_IP=$(doctl compute droplet list --format=PublicIPv4,Name --no-header | grep "$DROPLET_NAME" | cut -d ' ' -f 1)
		if [[ -z "$DROPLET_IP" ]]; then
			echo "Droplet IP not found"
			exit 1
		fi

		ssh -o StrictHostKeyChecking=no root@"$DROPLET_IP" "mariadb-dump --order-by-primary $DB_NAME | sed -e 's/DEFINER[ ]*=[ ]*[^*]*\*/\*/' > /root/backup.sql"
		scp -o StrictHostKeyChecking=no root@"$DROPLET_IP":/root/backup.sql "$BACKUP_SQL_PATH" >/dev/null 2>&1

		if [ ! -f "$BACKUP_SQL_PATH" ]; then
			echo "Backup failed: backup file not found"
			exit 1
		fi

		if [ ! -s "$BACKUP_SQL_PATH" ]; then
			echo "Backup failed: backup file is empty"
			exit 1
		fi

		if find "$BACKUP_SQL_PATH" -mmin +1 -print -quit | grep -q .; then
			echo "Backup failed: backup file is older than 1 minute"
			exit 1
		fi

		BACKUP_SQL_SIZE=$(stat -c%s "$BACKUP_SQL_PATH")
		if (( BACKUP_SQL_SIZE < 1024 )); then
			echo "Backup failed: backup file is too small"
			exit 1
		fi

		BACKUP_SQL_LAST_LINE=$(tail -n 1 "$BACKUP_SQL_PATH")
		if ! [[ "$BACKUP_SQL_LAST_LINE" =~ ^"-- Dump completed on " ]]; then
			echo "Backup failed: backup file does not appear to be valid"
			exit 1
		fi

		BACKUP_GPG_PATH="$BACKUP_SQL_PATH".gpg
		rm -f "$BACKUP_GPG_PATH"
		if [[ -n "$GPG_PASSPHRASE" ]]; then
			gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 -c --output "$BACKUP_GPG_PATH" "$BACKUP_SQL_PATH" 3<<< "$GPG_PASSPHRASE"
		else
			gpg -c --output "$BACKUP_GPG_PATH" "$BACKUP_SQL_PATH"
		fi

		if [ ! -f "$BACKUP_GPG_PATH" ]; then
			echo "File not found: $BACKUP_GPG_PATH"
			exit 1
		fi

		echo "Database Backed Up"
	fi
	doctl compute droplet delete "$DROPLET_ID" --force
	echo "Droplet Deleted"
fi

################################################################################
# delete app

echo "----------------------------------------"
echo "Deleting App..."

APP_ID=$(doctl apps list --format=ID,Spec.Name --no-header | grep "$APP_NAME" | cut -d ' ' -f 1)
if [[ -z "$APP_ID" ]]; then
	echo "App ID not found"
else
	doctl apps delete "$APP_ID" --force
	echo "App Deleted"
fi

################################################################################

exit 0
