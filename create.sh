#!/usr/bin/env bash
################################################################################
# Create a Digital Ocean instance of a gameshell-framework game.
#
# Usage:  ./create.sh APP_NAME
#   APP_NAME is the game name (e.g., timeline-trivia, card-judge). Config and
#   backups are read from games/APP_NAME/ relative to this script — deploy.conf
#   (see deploy.conf.template) and a backups/ directory holding at least one
#   GPG-encrypted database backup (*.sql.gpg).
#
# Operator secrets come from the environment (game-agnostic):
#   DEPLOY_SQL_USER      database user to create on the droplet
#   DEPLOY_SQL_PASSWORD  password for that user
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

# If this checkout is itself a fork (has a conventional "upstream" remote),
# check that too — same fetch-only, never-pull, confirm pattern, just
# against the original repo instead of the fork.
if ! git -C "$OPS_DIR" remote get-url upstream >/dev/null 2>&1; then
	echo "No 'upstream' remote configured (this checkout isn't a fork), skipping upstream check."
elif ! git -C "$OPS_DIR" fetch --quiet upstream 2>/dev/null; then
	echo "Could not fetch upstream (offline?), skipping upstream check."
else
	UPSTREAM_DEFAULT_BRANCH=$(git -C "$OPS_DIR" ls-remote --symref upstream HEAD | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#\1#p')
	if [ -z "$UPSTREAM_DEFAULT_BRANCH" ]; then
		echo "Could not determine upstream's default branch, skipping upstream check."
	else
		UPSTREAM_BEHIND_COUNT=$(git -C "$OPS_DIR" rev-list --count "HEAD..upstream/$UPSTREAM_DEFAULT_BRANCH")
		if [ "$UPSTREAM_BEHIND_COUNT" -gt 0 ]; then
			echo "This fork is $UPSTREAM_BEHIND_COUNT commit(s) behind upstream/$UPSTREAM_DEFAULT_BRANCH:"
			git -C "$OPS_DIR" log --oneline "HEAD..upstream/$UPSTREAM_DEFAULT_BRANCH"
			read -p "Continue anyway without syncing? (y/N): " CONFIRM_UPSTREAM_STALE
			if ! [[ "$CONFIRM_UPSTREAM_STALE" =~ ^[Yy]$ ]]; then
				echo "Aborted. Sync this fork with upstream/$UPSTREAM_DEFAULT_BRANCH, then try again."
				exit 1
			fi
		else
			echo "This fork is up to date with upstream/$UPSTREAM_DEFAULT_BRANCH."
		fi
	fi
fi

APP_NAME_ARG="${1:?Usage: ./create.sh APP_NAME}"
GAME_CONFIG_DIR="$OPS_DIR/games/$APP_NAME_ARG"

################################################################################
# load per-game config

CONFIG_PATH="$GAME_CONFIG_DIR/deploy.conf"
if [ ! -f "$CONFIG_PATH" ]; then
	echo "Config not found: $CONFIG_PATH"
	exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG_PATH"

: "${APP_NAME:?deploy.conf must set APP_NAME}"
: "${ENV_VAR_PREFIX:?deploy.conf must set ENV_VAR_PREFIX}"
: "${DB_NAME:?deploy.conf must set DB_NAME}"
: "${HTTP_PORT:?deploy.conf must set HTTP_PORT}"
: "${GIT_REPO:?deploy.conf must set GIT_REPO}"

DROPLET_REGION="${DROPLET_REGION:-nyc3}"
DROPLET_IMAGE="${DROPLET_IMAGE:-centos-stream-10-x64}"
DROPLET_NAME="$APP_NAME-database"

################################################################################
# check operator secrets

if [[ -z "$DEPLOY_SQL_USER" ]]; then
	echo "Environment variable not found: DEPLOY_SQL_USER"
	exit 1
fi

if [[ -z "$DEPLOY_SQL_PASSWORD" ]]; then
	echo "Environment variable not found: DEPLOY_SQL_PASSWORD"
	exit 1
fi

################################################################################
# get latest database backup (optional)

BACKUP_DIR="$GAME_CONFIG_DIR/backups"
BACKUP_GPG_FILE=$(ls "$BACKUP_DIR"/*.gpg 2>/dev/null | tail -n 1 || true)
BACKUP_SQL_PATH=""

if [[ -z "$BACKUP_GPG_FILE" ]]; then
	echo "No *.gpg backup found in: $BACKUP_DIR (creating fresh database)"
else
	BACKUP_SQL_PATH="${BACKUP_GPG_FILE::-4}"
	rm -f "$BACKUP_SQL_PATH"
	gpg -d --output "$BACKUP_SQL_PATH" "$BACKUP_GPG_FILE"

	if [ ! -f "$BACKUP_SQL_PATH" ]; then
		echo "File not found: $BACKUP_SQL_PATH"
		exit 1
	fi
fi

################################################################################
# render templates into temp copies (tracked templates are never mutated)
#
# Older versions of this script sed -i'd the secrets directly into the
# tracked templates/*.sh|yaml and ran `git checkout --` on them afterward to
# revert. That left real credentials sitting in a git-tracked file for the
# whole run, with no cleanup if the script died before reaching the revert.
# Rendering into a mktemp copy plus an EXIT trap means the tracked template
# is never touched and the copy is deleted no matter how the script exits.

SETUP_SCRIPT_PATH=$(mktemp)
APP_SPEC_PATH=$(mktemp)
trap 'rm -f "$SETUP_SCRIPT_PATH" "$APP_SPEC_PATH"' EXIT

sed \
	-e "s/REPLACE_SQL_USER/${DEPLOY_SQL_USER}/g" \
	-e "s/REPLACE_SQL_PASSWORD/${DEPLOY_SQL_PASSWORD}/g" \
	-e "s/REPLACE_DB_NAME/${DB_NAME}/g" \
	"$OPS_DIR/templates/setup.sh" > "$SETUP_SCRIPT_PATH"

################################################################################
# sync fork with upstream if configured
#
# GIT_REPO/GIT_UPSTREAM are just "owner/name" strings — no local checkout of
# the game repo exists anywhere in this flow, so this syncs the two remotes
# directly through a throwaway git dir rather than cd-ing into a checkout.

if [[ -n "$GIT_UPSTREAM" && "$GIT_UPSTREAM" != "$GIT_REPO" ]]; then
	echo "----------------------------------------"
	echo "Checking Fork Sync ($GIT_REPO vs $GIT_UPSTREAM)..."

	GIT_REPO_URL="https://github.com/$GIT_REPO.git"
	GIT_UPSTREAM_URL="https://github.com/$GIT_UPSTREAM.git"

	SYNC_DIR=$(mktemp -d)
	trap 'rm -rf "$SYNC_DIR"; rm -f "$SETUP_SCRIPT_PATH" "$APP_SPEC_PATH"' EXIT
	(
		cd "$SYNC_DIR"
		git init -q

		# Old card-judge-only version of this script hardcoded "main" here.
		# This is generic across games now, so the default branch can't be
		# assumed — detect it instead of hardcoding it.
		DEFAULT_BRANCH=$(git ls-remote --symref "$GIT_REPO_URL" HEAD | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#\1#p')
		: "${DEFAULT_BRANCH:?could not determine default branch of $GIT_REPO}"

		git fetch -q "$GIT_REPO_URL" "$DEFAULT_BRANCH":origin-head
		git fetch -q "$GIT_UPSTREAM_URL" "$DEFAULT_BRANCH":upstream-head

		COMMITS_TO_PUSH=$(git log origin-head..upstream-head --oneline)
		if [[ -z "$COMMITS_TO_PUSH" ]]; then
			echo "Fork is up to date with upstream."
		else
			echo "The following commits will be pushed from $GIT_UPSTREAM to $GIT_REPO:"
			echo "$COMMITS_TO_PUSH"
			read -p "Do you want to continue with the push? (y/N): " CONFIRM_PUSH
			if [[ "$CONFIRM_PUSH" =~ ^[Yy]$ ]]; then
				git push "$GIT_REPO_URL" upstream-head:"$DEFAULT_BRANCH"
			else
				echo "Push cancelled by user. Exiting script."
				exit 1
			fi
			echo "Fork Synced"
		fi
	)
fi

################################################################################
# get ssh key

echo "----------------------------------------"
echo "Which of the following SSH Keys should have access to the database droplet?"
doctl compute ssh-key list --format=Name --no-header
read -p "SSH Key Name: " SSH_KEY_NAME
if [[ -z "$SSH_KEY_NAME" ]]; then
	echo "SSH Key Name not provided"
	exit 1
fi

SSH_KEY_ID=$(doctl compute ssh-key list --format=ID,Name --no-header | grep "$SSH_KEY_NAME" | cut -d ' ' -f 1)
if [[ -z "$SSH_KEY_ID" ]]; then
	echo "SSH Key ID not found"
	exit 1
fi

################################################################################
# get price tier
#
# These AMD droplet sizes aren't sold in every DO region (notably not in
# nyc3, the default DROPLET_REGION), so `doctl compute droplet create` can
# fail with a 422 for a tier that looks fine here. The 3 arrays below are
# parallel and index-aligned (TIER_SLUGS[i]/TIER_APP_SIZES[i]/TIER_LABELS[i]
# all describe the same tier) — this is the one place tier definitions live;
# everything downstream, including the 422 handling later, reads from here.

echo "----------------------------------------"

TIER_SLUGS=("s-1vcpu-1gb-amd" "s-2vcpu-4gb-amd" "s-4vcpu-8gb-amd")
TIER_APP_SIZES=("basic-xs" "basic-s" "basic-m")
TIER_LABELS=("\$17/month, \$0.02518/hour" "\$48/month, \$0.07155/hour" "\$96/month, \$0.14273/hour")

# AVAILABLE_TIERS holds indices into TIER_SLUGS/TIER_APP_SIZES/TIER_LABELS
# (not the tiers themselves), so the menu below can renumber 1..N over
# however many tiers survive the check, however many that turns out to be.
if ! command -v jq >/dev/null 2>&1; then
	echo "*** No jq found, skipping tier availability pre-check ***"
	echo "Install jq (e.g. 'brew install jq' on macOS, 'apt install jq' on Debian/Ubuntu) to run the tier availability pre-check against the configured region on future runs."
	AVAILABLE_TIERS=(0 1 2) # no check ran, so assume all 3 are valid like before
else
	# "slug region" pairs, one per line, covering all 3 tiers at once. This
	# doesn't depend on DROPLET_REGION, so it's fetched once even if the loop
	# below retries with a different region.
	TIER_SLUGS_JSON=$(printf '%s\n' "${TIER_SLUGS[@]}" | jq -R . | jq -s .)
	TIER_REGION_PAIRS=$(doctl compute size list -o json | jq -r --argjson slugs "$TIER_SLUGS_JSON" '
		.[] | select(.slug as $s | $slugs | index($s)) | .slug as $s | .regions[] | "\($s) \(.)"
	')
	TIER_REGIONS=$(echo "$TIER_REGION_PAIRS" | awk '{print $2}' | sort -u)

	echo "Checking which price tiers are currently available in region $DROPLET_REGION..."
	while true; do
		AVAILABLE_TIERS=()
		for i in 0 1 2; do
			if echo "$TIER_REGION_PAIRS" | grep -qx "${TIER_SLUGS[$i]} $DROPLET_REGION"; then
				AVAILABLE_TIERS+=("$i")
			fi
		done

		if [ ${#AVAILABLE_TIERS[@]} -gt 0 ]; then
			break
		fi

		echo "None of the pre-defined price tiers (${TIER_SLUGS[*]}) are available in the configured region ($DROPLET_REGION)"
		echo "Set DROPLET_REGION in games/$APP_NAME_ARG/deploy.conf, or choose a different region below:"
		echo "Other Regions where at least one of these tiers is currently available:"
		doctl compute region list --format=Slug,Name --no-header | while read -r RSLUG RNAME; do
			if echo "$TIER_REGIONS" | grep -qx "$RSLUG"; then
				echo "  $RSLUG - $RNAME"
			fi
		done
		read -p "Enter a different region code to check (or leave blank to abort): " NEW_DROPLET_REGION
		if [[ -z "$NEW_DROPLET_REGION" ]]; then
			echo "Update DROPLET_REGION in games/$APP_NAME_ARG/deploy.conf to one of the above and try again."
			exit 1
		fi
		DROPLET_REGION="$NEW_DROPLET_REGION"
		echo "Checking which price tiers are currently available in region $DROPLET_REGION..."
	done
fi

echo "Choose price tier to host:"
for n in "${!AVAILABLE_TIERS[@]}"; do
	i="${AVAILABLE_TIERS[$n]}"
	echo "$((n + 1))) ${TIER_LABELS[$i]}"
done
read -p "Choice: " PRICE_TIER_CHOICE

if ! [[ "$PRICE_TIER_CHOICE" =~ ^[0-9]+$ ]] || [ "$PRICE_TIER_CHOICE" -lt 1 ] || [ "$PRICE_TIER_CHOICE" -gt "${#AVAILABLE_TIERS[@]}" ]; then
	echo "Invalid price tier choice"
	exit 1
fi

# PRICE_TIER_CHOICE is the displayed 1..N menu position; map it back through
# AVAILABLE_TIERS to the real index into TIER_SLUGS/TIER_APP_SIZES.
TIER_INDEX="${AVAILABLE_TIERS[$((PRICE_TIER_CHOICE - 1))]}"
DROPLET_SIZE="${TIER_SLUGS[$TIER_INDEX]}"
APP_SIZE="${TIER_APP_SIZES[$TIER_INDEX]}"

################################################################################
# create droplet

echo "----------------------------------------"
echo "Creating Droplet..."

if doctl compute droplet list --format=Name --no-header | grep -q "$DROPLET_NAME"; then
	echo "Droplet already exists"
	exit 1
fi

set +e
DROPLET_IP=$(
	doctl compute droplet create "$DROPLET_NAME" \
		--ssh-keys="$SSH_KEY_ID" \
		--region="$DROPLET_REGION" \
		--image="$DROPLET_IMAGE" \
		--size="$DROPLET_SIZE" \
		--user-data-file="$SETUP_SCRIPT_PATH" \
		--format=PublicIPv4 \
		--no-header \
		--wait 2>&1
)
DROPLET_CREATE_STATUS=$?
set -e

if [ "$DROPLET_CREATE_STATUS" -ne 0 ]; then
	echo "$DROPLET_IP"
	if echo "$DROPLET_IP" | grep -q "Size is not available in this region"; then
		echo "DROPLET_SIZE ($DROPLET_SIZE) is not available in region ($DROPLET_REGION)."
		echo "Update DROPLET_REGION in games/$APP_NAME_ARG/deploy.conf to a region that supports this size and try again."
		if ! command -v jq >/dev/null 2>&1; then
			echo "Install jq (e.g. 'brew install jq' on macOS, 'apt install jq' on Debian/Ubuntu) to catch this ahead of time via the tier availability pre-check."
		fi
	fi
	exit 1
fi

if [[ -z "$DROPLET_IP" ]]; then
	sleep 10
	DROPLET_IP=$(doctl compute droplet list --format=PublicIPv4,Name --no-header | grep "$DROPLET_NAME" | cut -d ' ' -f 1)
	if [[ -z "$DROPLET_IP" ]]; then
		echo "Droplet IP not found"
		exit 1
	fi
fi

DROPLET_ID=$(doctl compute droplet list --format=ID,Name --no-header | grep "$DROPLET_NAME" | cut -d ' ' -f 1)
if [[ -z "$DROPLET_ID" ]]; then
	echo "Droplet ID not found"
	exit 1
fi

echo "Droplet Created"

################################################################################
# finish droplet setup

echo "----------------------------------------"
echo "Finishing Droplet Setup..."

sleep 1m

DONE_CHECKS_REMAINING=15
while ! doctl compute droplet get "$DROPLET_ID" --format=Status --no-header | grep -q "off"; do
	((DONE_CHECKS_REMAINING--))
	if [ "$DONE_CHECKS_REMAINING" -eq 0 ]; then
		echo "Droplet never finished setup, deleting droplet..."
		doctl compute droplet delete "$DROPLET_ID" --force
		echo "Droplet Deleted"
		exit 1
	fi
	echo "Droplet setup not finished yet, waiting 1 minute..."
	sleep 1m
done

doctl compute droplet-action power-on "$DROPLET_ID" --wait > /dev/null
sleep 15s

echo "Waiting for SSH to become available..."
SSH_WAIT_REMAINING=20
until ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@"$DROPLET_IP" true; do
	((SSH_WAIT_REMAINING--))
	if [ "$SSH_WAIT_REMAINING" -le 0 ]; then
		echo "SSH did not become available within expected time."
		exit 1
	fi
	echo "SSH not ready yet, waiting 15 seconds..."
	sleep 15s
done

echo "Droplet Finished Setup"

################################################################################
# restore database from backup (if available)

echo "----------------------------------------"

if [[ -n "$BACKUP_SQL_PATH" ]]; then
	echo "Restoring Database from Backup..."
	scp -o StrictHostKeyChecking=no "$BACKUP_SQL_PATH" root@"$DROPLET_IP":/root/restore.sql >/dev/null 2>&1
	ssh root@"$DROPLET_IP" "mariadb $DB_NAME < /root/restore.sql"
	echo "Database Restored"
else
	echo "Creating Fresh Database..."
	ssh root@"$DROPLET_IP" "mariadb -e 'CREATE DATABASE IF NOT EXISTS $DB_NAME;'"
	echo "Database Created (app will initialize schema on startup)"
fi

################################################################################
# create app

echo "----------------------------------------"

if doctl apps list --format=Spec.Name --no-header | grep -q "$APP_NAME"; then
	echo "App already exists"
	exit 1
fi

sed \
	-e "s/REPLACE_APP_NAME/${APP_NAME}/g" \
	-e "s/REPLACE_ENV_VAR_PREFIX/${ENV_VAR_PREFIX}/g" \
	-e "s/REPLACE_SQL_HOST/${DROPLET_IP}/g" \
	-e "s/REPLACE_SQL_USER/${DEPLOY_SQL_USER}/g" \
	-e "s/REPLACE_SQL_PASSWORD/${DEPLOY_SQL_PASSWORD}/g" \
	-e "s/REPLACE_DB_NAME/${DB_NAME}/g" \
	-e "s/REPLACE_HTTP_PORT/${HTTP_PORT}/g" \
	-e "s/REPLACE_APP_SIZE/${APP_SIZE}/g" \
	-e "s|REPLACE_GIT_REPO|${GIT_REPO}|g" \
	"$OPS_DIR/templates/spec.yaml" > "$APP_SPEC_PATH"

APP_URL=$(
	doctl apps create \
		--spec="$APP_SPEC_PATH" \
		--format=DefaultIngress \
		--no-header \
		--wait
)

if [[ -z "$APP_URL" ]]; then
	sleep 10
	APP_URL=$(doctl apps list --format=DefaultIngress,Spec.Name --no-header | grep "$APP_NAME" | cut -d ' ' -f 1)
	if [[ -z "$APP_URL" ]]; then
		echo "App URL not found"
		exit 1
	fi
fi

echo "App URL: $APP_URL"

################################################################################

exit 0
