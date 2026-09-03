#!/usr/bin/env bash
################################################################################
# Create a Digital Ocean instance of a gameshell-framework game.
#
# Usage:  ./create.sh APP_NAME [--ssh-key=NAME] [--tier=1|2|3] [--region=SLUG] [--yes]
#         ./create.sh APP_NAME --list-tiers [--region=SLUG]
#         ./create.sh APP_NAME --list-regions
#   APP_NAME is the game name (e.g., timeline-trivia, card-judge). Config and
#   backups are read from games/APP_NAME/ relative to this script — deploy.conf
#   (see deploy.conf.template) and a backups/ directory holding at least one
#   GPG-encrypted database backup (*.sql.gpg).
#
#   The branch deployed comes from deploy.conf's GIT_BRANCH; left blank, the
#   repo's own default branch is detected and used.
#
#   --ssh-key=NAME  skip the SSH key prompt, use this key name
#   --tier=1|2|3    skip the price tier prompt, use this tier. The number
#                   always refers to the same tier (1=xs/2=s/3=m) regardless
#                   of region availability — see --list-tiers below.
#   --region=SLUG   deploy to this region instead of deploy.conf's
#                   DROPLET_REGION, without editing the tracked config. Also
#                   applies to --list-tiers, so a caller can check tiers for
#                   a region before committing to it.
#   --yes           auto-confirm the fork-sync push prompt
#   These flags exist so GUI wrappers can drive this script non-interactively;
#   omit any of them and the matching prompt below still runs as normal.
#
#   --list-tiers    print the tiers available in this game's configured
#                   region (one per line: NUMBER\tSLUG\tAPP_SIZE\tLABEL) and
#                   exit before touching secrets, backups, or the network
#                   beyond the availability check itself. Doesn't deploy
#                   anything — this is the same availability check the
#                   interactive/--tier paths run below, exposed standalone so
#                   a GUI can populate a tier dropdown without duplicating
#                   this logic in another language. NUMBER is stable and is
#                   exactly what --tier= above expects back.
#   --list-regions  print the regions offering at least one of these tiers
#                   (one per line: SLUG\tNAME) and exit, same query-only
#                   contract as --list-tiers. This is the same list the
#                   interactive retry prompt below offers when the configured
#                   region has no tiers available.
#
# Operator secrets come from the environment (game-agnostic):
#   DEPLOY_SQL_USER      database user to create on the droplet
#   DEPLOY_SQL_PASSWORD  password for that user
#   GPG_PASSPHRASE       optional; decrypts the backup non-interactively
#                        (--batch --passphrase-fd) instead of prompting via
#                        pinentry. Needed when driven from the GUI, which has
#                        no TTY for pinentry to use; omit it for normal
#                        interactive CLI use and gpg prompts as usual.
#
# Extra per-game secrets (API keys, etc.) are listed by NAME only in
# deploy.conf's EXTRA_ENV_VARS and read from the environment at create
# time — same rule as DEPLOY_SQL_*: values never live in a file. Each
# name is injected onto the DO app as-is (not prefixed).
################################################################################

set -e # exit on any command error

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"

################################################################################
# parse args

SSH_KEY_NAME_FLAG=""
PRICE_TIER_FLAG=""
REGION_FLAG=""
AUTO_YES=0
LIST_TIERS=0
LIST_REGIONS=0
APP_NAME_ARG=""
for arg in "$@"; do
	case "$arg" in
		--ssh-key=*) SSH_KEY_NAME_FLAG="${arg#*=}" ;;
		--tier=*) PRICE_TIER_FLAG="${arg#*=}" ;;
		--region=*) REGION_FLAG="${arg#*=}" ;;
		--yes) AUTO_YES=1 ;;
		--list-tiers) LIST_TIERS=1 ;;
		--list-regions) LIST_REGIONS=1 ;;
		-*)
			echo "Unknown option: $arg"
			exit 1
			;;
		*) APP_NAME_ARG="$arg" ;;
	esac
done
: "${APP_NAME_ARG:?Usage: ./create.sh APP_NAME [--ssh-key=NAME] [--tier=1|2|3] [--region=SLUG] [--yes] [--list-tiers] [--list-regions]}"
GAME_CONFIG_DIR="$OPS_DIR/games/$APP_NAME_ARG"

# Both --list-* flags are query-only: they print and exit without deploying,
# so everything below that exists to protect a real deploy (the staleness
# checks, secret validation) is skipped for them.
QUERY_ONLY=0
if [ "$LIST_TIERS" -eq 1 ] || [ "$LIST_REGIONS" -eq 1 ]; then
	QUERY_ONLY=1
fi

################################################################################
# check for new commits on this checkout's remote (never pulls automatically)
#
# This is gameshell-deploy's own git history, not the game's — bug fixes and
# behavior changes land here too, so a stale checkout can run with outdated
# logic. Only warns and confirms; never fetches destructively or merges.
# Skipped for the --list-* query modes: a GUI may call those repeatedly (e.g.
# every time the operator changes the region) and they don't need a network
# round-trip and a possible interactive prompt just to answer a question.

if [ "$QUERY_ONLY" -eq 1 ]; then
	: # skip, see comment above
else
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
fi

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

# Optional: space-separated env var names copied from the operator's
# environment onto the DO app. Empty means SQL creds only.
EXTRA_ENV_VARS="${EXTRA_ENV_VARS:-}"

DROPLET_REGION="${DROPLET_REGION:-nyc3}"
# --region overrides deploy.conf for this run only — the tracked config is
# never rewritten, so a one-off deploy elsewhere doesn't silently become the
# game's new permanent region.
if [[ -n "$REGION_FLAG" ]]; then
	DROPLET_REGION="$REGION_FLAG"
fi
DROPLET_IMAGE="${DROPLET_IMAGE:-centos-stream-10-x64}"
DROPLET_NAME="$APP_NAME-database"

################################################################################
# get price tier
#
# These AMD droplet sizes aren't sold in every DO region (notably not in
# nyc3, the default DROPLET_REGION), so `doctl compute droplet create` can
# fail with a 422 for a tier that looks fine here. The 3 arrays below are
# parallel and index-aligned (TIER_SLUGS[i]/TIER_APP_SIZES[i]/TIER_LABELS[i]
# all describe the same tier) — this is the one place tier definitions live;
# everything downstream, including the 422 handling later, reads from here.
#
# This runs before the operator-secrets/backup/fork-sync sections below on
# purpose: it's a pure read-only check against DROPLET_REGION (from
# deploy.conf) and doesn't need DEPLOY_SQL_USER/PASSWORD or anything else,
# so a bad region/tier combination (or a --list-tiers query) fails fast
# without requiring secrets to be set first.

if [ "$QUERY_ONLY" -eq 0 ]; then
	echo "----------------------------------------"
fi

TIER_SLUGS=("s-1vcpu-1gb-amd" "s-2vcpu-4gb-amd" "s-4vcpu-8gb-amd")
TIER_APP_SIZES=("basic-xs" "basic-s" "basic-m")
TIER_LABELS=("\$17/month, \$0.02518/hour" "\$48/month, \$0.07155/hour" "\$96/month, \$0.14273/hour")

# Prints "SLUG\tNAME" for every region offering at least one of the tiers
# above. Only ever called once TIER_REGIONS has been populated — an empty
# TIER_REGIONS means availability couldn't be determined, which is handled
# as an error at the point of computation rather than silently degrading
# into "every region qualifies" here.
print_available_regions() {
	doctl compute region list --format=Slug,Name --no-header | while read -r RSLUG RNAME; do
		if echo "$TIER_REGIONS" | grep -qx "$RSLUG"; then
			printf '%s\t%s\n' "$RSLUG" "$RNAME"
		fi
	done
}

# AVAILABLE_TIERS holds indices into TIER_SLUGS/TIER_APP_SIZES/TIER_LABELS
# (not the tiers themselves, and not 1-based tier numbers) — it's whatever
# subset of 0/1/2 the region check below found available.
TIER_REGIONS=""
if ! command -v jq >/dev/null 2>&1; then
	# The --list-* query modes must never guess. Their whole purpose is
	# telling a caller what's actually available, and answering "all of
	# them, everywhere" unchecked renders in a GUI as a confident list of
	# tiers and regions that will 422 at create time — worse than saying
	# nothing. Interactive CLI use keeps the permissive fallback below,
	# where the operator sees the warning and the API is the final judge.
	if [ "$QUERY_ONLY" -eq 1 ]; then
		echo "jq is required for --list-tiers/--list-regions: it parses 'doctl compute size list' output to determine which tiers a region actually offers. Install jq (e.g. 'sudo apt install jq' on Debian/Ubuntu, 'brew install jq' on macOS) and try again." >&2
		exit 3
	fi
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

	check_available_tiers() {
		AVAILABLE_TIERS=()
		for i in 0 1 2; do
			if echo "$TIER_REGION_PAIRS" | grep -qx "${TIER_SLUGS[$i]} $DROPLET_REGION"; then
				AVAILABLE_TIERS+=("$i")
			fi
		done
	}

	# No pairs means the size lookup told us nothing — a doctl hiccup, an
	# auth/rate-limit failure, or an API shape change. Treating that as
	# "no constraints" would quietly hand back every region and every tier,
	# which is exactly how nyc3 (which sells none of these sizes) ends up
	# offered as a valid choice. Query modes fail loudly instead; the
	# interactive path degrades to the same permissive fallback as no-jq,
	# where the operator sees the warning and the API is the final judge.
	if [[ -z "$TIER_REGION_PAIRS" ]]; then
		if [ "$QUERY_ONLY" -eq 1 ]; then
			echo "Could not determine tier availability: 'doctl compute size list' returned no data for the expected sizes (${TIER_SLUGS[*]}). Check that doctl is authenticated and reachable, then try again." >&2
			exit 4
		fi
		echo "*** Could not determine tier availability from 'doctl compute size list' — skipping the pre-check ***"
		AVAILABLE_TIERS=(0 1 2)
	elif [ "$QUERY_ONLY" -eq 1 ]; then
		# Query mode: check once against the configured region and report
		# whatever is found (possibly nothing) — no interactive region retry.
		check_available_tiers
	else
		echo "Checking which price tiers are currently available in region $DROPLET_REGION..."
		check_available_tiers
		while [ ${#AVAILABLE_TIERS[@]} -eq 0 ]; do
			echo "None of the pre-defined price tiers (${TIER_SLUGS[*]}) are available in the configured region ($DROPLET_REGION)"
			echo "Set DROPLET_REGION in games/$APP_NAME_ARG/deploy.conf, or choose a different region below:"
			echo "Other Regions where at least one of these tiers is currently available:"
			print_available_regions | while IFS=$'\t' read -r RSLUG RNAME; do
				echo "  $RSLUG - $RNAME"
			done
			read -p "Enter a different region code to check (or leave blank to abort): " NEW_DROPLET_REGION
			if [[ -z "$NEW_DROPLET_REGION" ]]; then
				echo "Update DROPLET_REGION in games/$APP_NAME_ARG/deploy.conf to one of the above and try again."
				exit 1
			fi
			DROPLET_REGION="$NEW_DROPLET_REGION"
			echo "Checking which price tiers are currently available in region $DROPLET_REGION..."
			check_available_tiers
		done
	fi
fi

if [ "$LIST_REGIONS" -eq 1 ]; then
	print_available_regions
	exit 0
fi

if [ "$LIST_TIERS" -eq 1 ]; then
	for i in "${AVAILABLE_TIERS[@]}"; do
		printf '%s\t%s\t%s\t%s\n' "$((i + 1))" "${TIER_SLUGS[$i]}" "${TIER_APP_SIZES[$i]}" "${TIER_LABELS[$i]}"
	done
	exit 0
fi

if [[ -n "$PRICE_TIER_FLAG" ]]; then
	# --tier is always the stable 1-based tier number (matching TIER_SLUGS),
	# never the position in the filtered menu below — that position shifts
	# depending on region availability, so a fixed flag value can't target it
	# reliably. --list-tiers reports the same stable numbering.
	if ! [[ "$PRICE_TIER_FLAG" =~ ^[0-9]+$ ]] || [ "$PRICE_TIER_FLAG" -lt 1 ] || [ "$PRICE_TIER_FLAG" -gt 3 ]; then
		echo "Invalid --tier value: $PRICE_TIER_FLAG (must be 1, 2, or 3)"
		exit 1
	fi
	TIER_INDEX=$((PRICE_TIER_FLAG - 1))
	if ! printf '%s\n' "${AVAILABLE_TIERS[@]}" | grep -qx "$TIER_INDEX"; then
		echo "Tier $PRICE_TIER_FLAG (${TIER_SLUGS[$TIER_INDEX]}) is not available in region $DROPLET_REGION."
		echo "Available tiers in this region:"
		for i in "${AVAILABLE_TIERS[@]}"; do
			echo "  $((i + 1))) ${TIER_LABELS[$i]}"
		done
		exit 1
	fi
	echo "Price tier: $PRICE_TIER_FLAG (${TIER_LABELS[$TIER_INDEX]}) (from --tier)"
else
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

	# PRICE_TIER_CHOICE is the displayed 1..N menu position; map it back
	# through AVAILABLE_TIERS to the real index into TIER_SLUGS/TIER_APP_SIZES.
	TIER_INDEX="${AVAILABLE_TIERS[$((PRICE_TIER_CHOICE - 1))]}"
fi
DROPLET_SIZE="${TIER_SLUGS[$TIER_INDEX]}"
APP_SIZE="${TIER_APP_SIZES[$TIER_INDEX]}"

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

# EXTRA_ENV_VARS names are validated and required here, before the droplet
# is created, so a missing API key fails the same way a missing SQL
# password does — not after there are cloud resources to clean up.
if [[ -n "$EXTRA_ENV_VARS" ]]; then
	for extra_key in $EXTRA_ENV_VARS; do
		if ! [[ "$extra_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
			echo "Invalid EXTRA_ENV_VARS name: $extra_key"
			echo "Names must be alphanumeric-plus-underscore identifiers."
			exit 1
		fi
		if [[ -z "${!extra_key}" ]]; then
			echo "Environment variable not found: $extra_key"
			echo "Set it in the environment (same as DEPLOY_SQL_USER/PASSWORD). deploy.conf lists the name only."
			exit 1
		fi
		if [[ "${!extra_key}" == *$'\n'* || "${!extra_key}" == *$'\r'* ]]; then
			echo "Environment variable $extra_key contains a newline; refusing to put it in the app spec."
			exit 1
		fi
	done
fi

################################################################################
# resolve the branch to deploy
#
# GIT_BRANCH is optional. Left blank it resolves to the repo's own default
# branch, detected the same way the fork-sync step below detects it — the
# old card-judge-only script hardcoded "main" here, which silently deploys
# the wrong branch for any repo whose default is something else.
#
# Resolved before the backup is decrypted and long before the droplet is
# created, so a branch that doesn't exist fails here rather than after
# there's a droplet to clean up.

GIT_REPO_URL="https://github.com/$GIT_REPO.git"

echo "----------------------------------------"
if [[ -z "$GIT_BRANCH" ]]; then
	GIT_BRANCH=$(git ls-remote --symref "$GIT_REPO_URL" HEAD | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#\1#p')
	: "${GIT_BRANCH:?could not determine the default branch of $GIT_REPO — set GIT_BRANCH in deploy.conf}"
	echo "Deploying Branch: $GIT_BRANCH (default branch of $GIT_REPO)"
else
	if ! git ls-remote --exit-code --heads "$GIT_REPO_URL" "$GIT_BRANCH" >/dev/null 2>&1; then
		echo "Branch not found in $GIT_REPO: $GIT_BRANCH"
		echo "Fix GIT_BRANCH in games/$APP_NAME_ARG/deploy.conf (leave it blank to use the repo's default branch)."
		exit 1
	fi
	echo "Deploying Branch: $GIT_BRANCH (from deploy.conf)"
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
	if [[ -n "$GPG_PASSPHRASE" ]]; then
		gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 -d --output "$BACKUP_SQL_PATH" "$BACKUP_GPG_FILE" 3<<< "$GPG_PASSPHRASE"
	else
		gpg -d --output "$BACKUP_SQL_PATH" "$BACKUP_GPG_FILE"
	fi

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
	echo "Checking Fork Sync ($GIT_REPO vs $GIT_UPSTREAM, branch $GIT_BRANCH)..."

	GIT_UPSTREAM_URL="https://github.com/$GIT_UPSTREAM.git"

	SYNC_DIR=$(mktemp -d)
	trap 'rm -rf "$SYNC_DIR"; rm -f "$SETUP_SCRIPT_PATH" "$APP_SPEC_PATH"' EXIT
	(
		cd "$SYNC_DIR"
		git init -q

		# Syncs the branch being deployed, resolved above — syncing one
		# branch while deploying another would push commits nobody is about
		# to run, and leave the deployed branch stale.
		git fetch -q "$GIT_REPO_URL" "$GIT_BRANCH":origin-head
		git fetch -q "$GIT_UPSTREAM_URL" "$GIT_BRANCH":upstream-head

		COMMITS_TO_PUSH=$(git log origin-head..upstream-head --oneline)
		if [[ -z "$COMMITS_TO_PUSH" ]]; then
			echo "Fork is up to date with upstream."
		else
			echo "The following commits will be pushed from $GIT_UPSTREAM to $GIT_REPO:"
			echo "$COMMITS_TO_PUSH"
			if [[ "$AUTO_YES" -eq 1 ]]; then
				echo "Auto-confirming push (--yes)"
				git push "$GIT_REPO_URL" upstream-head:"$GIT_BRANCH"
			else
				read -p "Do you want to continue with the push? (y/N): " CONFIRM_PUSH
				if [[ "$CONFIRM_PUSH" =~ ^[Yy]$ ]]; then
					git push "$GIT_REPO_URL" upstream-head:"$GIT_BRANCH"
				else
					echo "Push cancelled by user. Exiting script."
					exit 1
				fi
			fi
			echo "Fork Synced"
		fi
	)
fi

################################################################################
# get ssh key

echo "----------------------------------------"
if [[ -n "$SSH_KEY_NAME_FLAG" ]]; then
	SSH_KEY_NAME="$SSH_KEY_NAME_FLAG"
	echo "SSH Key Name: $SSH_KEY_NAME (from --ssh-key)"
else
	echo "Which of the following SSH Keys should have access to the database droplet?"
	doctl compute ssh-key list --format=Name --no-header
	read -p "SSH Key Name: " SSH_KEY_NAME
fi
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
	-e "s|REPLACE_GIT_BRANCH|${GIT_BRANCH}|g" \
	"$OPS_DIR/templates/spec.yaml" > "$APP_SPEC_PATH"

# Extra env vars are appended to the rendered spec rather than going
# through sed: their values can contain `/` or `|` (the delimiters the
# substitutions above use), and they aren't known at template-authoring
# time. Inserted immediately before the service's `github:` block, which
# follows `envs:` in templates/spec.yaml. Values are double-quoted YAML
# scalars so `#`, `:`, etc. in an API key don't get parsed as YAML.
if [[ -n "$EXTRA_ENV_VARS" ]]; then
	echo "Injecting Extra Env Vars..."
	EXTRA_SPEC_PATH=$(mktemp)
	# This tempfile holds API keys, same as APP_SPEC_PATH holds the SQL
	# password — extend the EXIT trap rather than replacing it, so the
	# fork-sync dir (if any) is still cleaned up.
	if [[ -n "${SYNC_DIR:-}" ]]; then
		trap 'rm -rf "$SYNC_DIR"; rm -f "$SETUP_SCRIPT_PATH" "$APP_SPEC_PATH" "$EXTRA_SPEC_PATH"' EXIT
	else
		trap 'rm -f "$SETUP_SCRIPT_PATH" "$APP_SPEC_PATH" "$EXTRA_SPEC_PATH"' EXIT
	fi
	INSERTED=0
	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ $INSERTED -eq 0 && "$line" == "  github:" ]]; then
			for extra_key in $EXTRA_ENV_VARS; do
				extra_val="${!extra_key}"
				escaped=${extra_val//\\/\\\\}
				escaped=${escaped//\"/\\\"}
				printf '  - key: %s\n    scope: RUN_AND_BUILD_TIME\n    value: "%s"\n' "$extra_key" "$escaped"
			done
			INSERTED=1
		fi
		printf '%s\n' "$line"
	done < "$APP_SPEC_PATH" > "$EXTRA_SPEC_PATH"
	mv "$EXTRA_SPEC_PATH" "$APP_SPEC_PATH"
	if [[ $INSERTED -eq 0 ]]; then
		echo "Could not inject EXTRA_ENV_VARS: no '  github:' marker in the rendered app spec"
		exit 1
	fi
	echo "Extra Env Vars Injected"
fi

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
