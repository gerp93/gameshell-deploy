#!/usr/bin/env bash
################################################################################
# Redeploy the app code of an existing Digital Ocean instance of a
# gameshell-framework game, leaving the database droplet running.
#
# Usage:  ./redeploy.sh APP_NAME [--backup=yes|no] [--ssh-key=NAME] [--force-rebuild] [--yes]
#         ./redeploy.sh APP_NAME --check
#   APP_NAME is the game name (e.g., timeline-trivia, card-judge). Config is
#   read from games/APP_NAME/deploy.conf. The app and database droplet must
#   already exist (see create.sh); nothing is created or deleted — App
#   Platform just builds the latest commit of the branch and rolls it out.
#
#   The game applies its own schema migrations on startup (idempotent SQL,
#   re-run on every boot), so a live database is migrated in place. If the
#   new build fails to start, App Platform keeps serving the previous one.
#
#   Before deploying this script:
#     - syncs the fork with its upstream, if deploy.conf sets GIT_UPSTREAM
#     - warns if the commits about to ship add destructive SQL (DROP, DELETE,
#       UPDATE, TRUNCATE, MODIFY/CHANGE column) compared with what is deployed
#     - writes a fresh GPG-encrypted backup into games/APP_NAME/backups
#       (unless declined), which create.sh restores from next time
#
#   The app spec is NOT re-rendered: env vars (SQL host, extra API keys), the
#   app size, and the branch stay as create.sh set them. To change those,
#   tear down and create again.
#
#   --backup=yes|no   skip the backup prompt, use this answer
#   --ssh-key=NAME    skip the SSH key prompt, use this key name for the
#                     backup ssh/scp. Same name resolution as create.sh.
#                     Ignored when not backing up.
#   --force-rebuild   rebuild without reusing App Platform's build cache
#   --yes             auto-confirm the fork-sync push and the destructive-SQL
#                     warning prompts
#   These flags exist so GUI wrappers can drive this script non-interactively;
#   omit them and the matching prompts below still run as normal.
#
#   --check           read-only: report whether the branch has commits newer
#                     than what is deployed, then exit before any prompt,
#                     backup, or deployment. A GUI uses this to tell the
#                     operator there is new code to redeploy without
#                     duplicating this logic in another language. Prints one
#                     machine-readable line (tab-separated):
#                       REDEPLOY_CHECK STATE DEPLOYED LATEST COMMITS BRANCH NOTE
#                     STATE is current, behind, unknown, or no-app. COMMITS is
#                     the number of new commits (blank when it couldn't be
#                     counted); NOTE says why when STATE is unknown or the
#                     commits couldn't be compared. When behind, any
#                     destructive SQL those commits add follows, one
#                     "REDEPLOY_CHECK_SQL<TAB>file: line" per hit — the same
#                     lines the pre-deploy warning prints, so a GUI can show
#                     them before it passes --yes. Other output lines are
#                     progress noise; only lines with these prefixes count.
#
# Operator secret (optional): GPG_PASSPHRASE encrypts the new backup
# non-interactively (--batch --passphrase-fd) instead of prompting via
# pinentry. Needed when driven from the GUI, which has no TTY for pinentry
# to use; omit it for normal interactive CLI use and gpg prompts as usual.
################################################################################

set -e # exit on any command error

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"

################################################################################
# parse args

BACKUP_FLAG=""
SSH_KEY_NAME_FLAG=""
FORCE_REBUILD=0
AUTO_YES=0
CHECK_ONLY=0
APP_NAME_ARG=""
for arg in "$@"; do
	case "$arg" in
		--backup=*) BACKUP_FLAG="${arg#*=}" ;;
		--ssh-key=*) SSH_KEY_NAME_FLAG="${arg#*=}" ;;
		--force-rebuild) FORCE_REBUILD=1 ;;
		--yes) AUTO_YES=1 ;;
		--check) CHECK_ONLY=1 ;;
		-*)
			echo "Unknown option: $arg"
			exit 1
			;;
		*) APP_NAME_ARG="$arg" ;;
	esac
done
: "${APP_NAME_ARG:?Usage: ./redeploy.sh APP_NAME [--backup=yes|no] [--ssh-key=NAME] [--force-rebuild] [--yes] | --check}"
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
: "${GIT_REPO:?deploy.conf must set GIT_REPO}"

DROPLET_NAME="$APP_NAME-database"
BACKUP_DIR="$GAME_CONFIG_DIR/backups"
GIT_REPO_URL="https://github.com/$GIT_REPO.git"

# Where the newest code comes from: the upstream when this game is a fork (the
# fork-sync step below pushes it into GIT_REPO before deploying), otherwise
# GIT_REPO itself.
GIT_UPSTREAM_URL=""
LATEST_SOURCE_URL="$GIT_REPO_URL"
if [[ -n "$GIT_UPSTREAM" && "$GIT_UPSTREAM" != "$GIT_REPO" ]]; then
	GIT_UPSTREAM_URL="https://github.com/$GIT_UPSTREAM.git"
	LATEST_SOURCE_URL="$GIT_UPSTREAM_URL"
fi

# Throwaway git dir: no local checkout of the game repo exists anywhere in
# this flow, so every fetch/diff/push below goes through this instead.
WORK_DIR=$(mktemp -d)
git -C "$WORK_DIR" init -q
SSH_IDENTITY_TEMP=""
trap 'rm -rf "$WORK_DIR"; [[ -n "$SSH_IDENTITY_TEMP" ]] && rm -f "$SSH_IDENTITY_TEMP"' EXIT

################################################################################
# find the existing app
#
# Redeploy only makes sense for something create.sh already made, so a missing
# app is an error here rather than something to create. (--check reports it as
# a state instead, so a GUI can ask about a game that isn't deployed.)

echo "----------------------------------------"
APP_ID=$(doctl apps list --format=ID,Spec.Name --no-header | grep "$APP_NAME" | cut -d ' ' -f 1)
if [[ -z "$APP_ID" ]]; then
	if [ "$CHECK_ONLY" -eq 1 ]; then
		printf 'REDEPLOY_CHECK\tno-app\t\t\t\t\t\n'
		exit 0
	fi
	echo "App not found: $APP_NAME"
	echo "Nothing to redeploy. Use ./create.sh $APP_NAME to deploy it first."
	exit 1
fi
echo "Found App: $APP_NAME ($APP_ID)"

################################################################################
# resolve the branch to deploy
#
# Same rules as create.sh: GIT_BRANCH if set (validated against the remote),
# otherwise the repo's own default branch. The deployment itself builds
# whatever branch the app spec was created with; this is the branch this
# script syncs and scans, so it should match what create.sh deployed.

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
# what is deployed vs. what is out there
#
# doctl pretty-prints its JSON, so a plain grep finds the deployed commit
# without jq (this repo has no jq dependency for a single lookup). Empty when
# it can't be read; everything below treats that as "unknown", never an error.

DEPLOYED_SHA=$(doctl apps get "$APP_ID" -o json | grep -o '"source_commit_hash": *"[0-9a-f]\{7,40\}"' | head -n 1 | sed 's/.*"\([0-9a-f]*\)"$/\1/')

# Fetches the newest commit of the branch (as new-head) and the deployed commit
# into WORK_DIR, so they can be counted and diffed. The deployed commit comes
# from GIT_REPO — that's what App Platform built — while new-head comes from
# wherever the newest code is. Fails quietly (returns non-zero) so callers can
# skip the comparison rather than block on it.
fetch_range() {
	git -C "$WORK_DIR" fetch -q "$LATEST_SOURCE_URL" "$GIT_BRANCH":new-head 2>/dev/null &&
		git -C "$WORK_DIR" fetch -q "$GIT_REPO_URL" "$DEPLOYED_SHA" 2>/dev/null
}

# Prints "file: line" for each destructive SQL line added between the deployed
# commit and new-head. The game re-runs its whole SQL manifest on startup, so
# SQL added since the deployed commit is what will run against the live
# database. Additive changes (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
# EXISTS) are routine; what deserves a pause is anything that removes or
# rewrites data or columns, since the still-running old version may break
# against it and only the backup can undo it. Only *added* lines count, so a
# long-standing idempotent DROP ... IF EXISTS that re-runs on every boot
# doesn't trip it, and comment lines are ignored. This is a heuristic, not a
# parser; ON DELETE CASCADE and the like are deliberately not matched.
scan_destructive_sql() {
	git -C "$WORK_DIR" diff -U0 --no-color "$DEPLOYED_SHA" new-head -- '*.sql' | awk '
		/^\+\+\+ / { file = substr($0, 7); next }
		/^\+/ {
			line = substr($0, 2)
			if (line ~ /^[ \t]*--/) next
			u = toupper(line)
			if (u ~ /DROP[ \t]+(COLUMN|TABLE|INDEX|KEY|CONSTRAINT|FOREIGN)/ || u ~ /TRUNCATE/ || u ~ /^[ \t]*(DELETE|UPDATE)[ \t]/ || u ~ /[ \t](MODIFY|CHANGE)[ \t]/) {
				print file ": " line
			}
		}
	'
}

################################################################################
# --check: report and stop
#
# Read-only and prompt-free, so a GUI can call it on every game selection (and
# on a timer) without side effects. Everything is "best effort": a comparison
# that can't be made becomes STATE=unknown with a NOTE, not a failure.

if [ "$CHECK_ONLY" -eq 1 ]; then
	CHECK_STATE="unknown"
	CHECK_NOTE=""
	CHECK_COMMITS=""
	DESTRUCTIVE_SQL=""
	LATEST_SHA=$(git ls-remote "$LATEST_SOURCE_URL" "refs/heads/$GIT_BRANCH" 2>/dev/null | cut -f 1 | head -n 1)

	if [[ -z "$DEPLOYED_SHA" ]]; then
		CHECK_NOTE="could not read the deployed commit from DigitalOcean"
	elif [[ -z "$LATEST_SHA" ]]; then
		CHECK_NOTE="could not read branch $GIT_BRANCH from ${LATEST_SOURCE_URL#https://github.com/}"
	elif [[ "$LATEST_SHA" == "$DEPLOYED_SHA"* ]]; then
		CHECK_STATE="current"
	elif fetch_range; then
		CHECK_COMMITS=$(git -C "$WORK_DIR" rev-list --count "$DEPLOYED_SHA..new-head")
		if [[ "$CHECK_COMMITS" -gt 0 ]]; then
			CHECK_STATE="behind"
			DESTRUCTIVE_SQL=$(scan_destructive_sql)
		else
			# Different commit but nothing new on top of the deployed one:
			# the branch was rewound or the deployed commit is ahead of it.
			CHECK_STATE="current"
		fi
	else
		CHECK_STATE="behind"
		CHECK_NOTE="could not compare the commits, so SQL changes were not checked"
	fi

	printf 'REDEPLOY_CHECK\t%s\t%s\t%s\t%s\t%s\t%s\n' "$CHECK_STATE" "$DEPLOYED_SHA" "$LATEST_SHA" "$CHECK_COMMITS" "$GIT_BRANCH" "$CHECK_NOTE"
	if [[ -n "$DESTRUCTIVE_SQL" ]]; then
		while IFS= read -r sql_line; do
			printf 'REDEPLOY_CHECK_SQL\t%s\n' "$sql_line"
		done <<< "$DESTRUCTIVE_SQL"
	fi
	exit 0
fi

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
# sync fork with upstream if configured
#
# GIT_REPO/GIT_UPSTREAM are just "owner/name" strings — no local checkout of
# the game repo exists anywhere in this flow, so this syncs the two remotes
# directly through the throwaway git dir rather than cd-ing into a checkout.

if [[ -n "$GIT_UPSTREAM_URL" ]]; then
	echo "----------------------------------------"
	echo "Checking Fork Sync ($GIT_REPO vs $GIT_UPSTREAM, branch $GIT_BRANCH)..."

	(
		cd "$WORK_DIR"
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
# warn about destructive SQL in the commits about to ship
#
# See scan_destructive_sql above for what counts. Only ever warns and
# confirms. Best effort: if the deployed commit can't be determined or
# fetched, say so and carry on rather than blocking the redeploy.

echo "----------------------------------------"
echo "Checking Pending SQL Changes..."

if [[ -z "$DEPLOYED_SHA" ]]; then
	echo "Could not determine the currently deployed commit, skipping SQL check."
elif ! fetch_range; then
	echo "Could not fetch $GIT_BRANCH or deployed commit ${DEPLOYED_SHA:0:7} from GitHub, skipping SQL check."
else
	NEW_SHA=$(git -C "$WORK_DIR" rev-parse new-head)
	if [[ "$DEPLOYED_SHA" == "$NEW_SHA" ]]; then
		echo "Deployed commit ${DEPLOYED_SHA:0:7} is already the latest on $GIT_BRANCH; no new SQL."
	else
		echo "Deployed ${DEPLOYED_SHA:0:7} -> latest ${NEW_SHA:0:7}"
		DESTRUCTIVE_SQL=$(scan_destructive_sql)
		if [[ -z "$DESTRUCTIVE_SQL" ]]; then
			echo "No destructive SQL added since the deployed commit."
		else
			echo "*** The new commits add SQL that removes or rewrites data/columns: ***"
			echo "$DESTRUCTIVE_SQL" | sed 's/^/  /'
			echo "It runs against the live database on startup. If the new build then fails,"
			echo "the old version keeps serving but may break against the changed schema;"
			echo "the backup below is the only way back."
			if [[ "$AUTO_YES" -eq 1 ]]; then
				echo "Auto-confirming (--yes)"
			else
				read -p "Continue with the redeploy? (y/N): " CONFIRM_DESTRUCTIVE
				if ! [[ "$CONFIRM_DESTRUCTIVE" =~ ^[Yy]$ ]]; then
					echo "Aborted. Nothing was deployed."
					exit 1
				fi
			fi
		fi
	fi
fi

################################################################################
# back up the live database

DROPLET_ID=$(doctl compute droplet list --format=ID,Name --no-header | grep "$DROPLET_NAME" | cut -d ' ' -f 1)
BACKUP_GPG_PATH=""

echo "----------------------------------------"
if [[ -n "$BACKUP_FLAG" ]]; then
	BACKUP_DB=$( [[ "$BACKUP_FLAG" == "no" ]] && echo "n" || echo "y" )
	echo "Backup database? $BACKUP_DB (from --backup)"
else
	read -p "Do you want to backup the database first? [Y/n]: " BACKUP_DB
fi

if [[ "$BACKUP_DB" == "n" ]]; then
	echo "Skipping backup."
else
	if [[ -z "$DROPLET_ID" ]]; then
		echo "Droplet not found: $DROPLET_NAME"
		echo "Cannot back up. Re-run with --backup=no to redeploy anyway."
		exit 1
	fi

	# Same name-resolution loop as create.sh/delete.sh: substring first, exact
	# name if more than one DigitalOcean key matches. Loops only when
	# SSH_KEY_NAME_FLAG is unset — --ssh-key is how the GUI drives this, and a
	# retry loop there would hang waiting on stdin that never comes.
	while true; do
		if [[ -n "$SSH_KEY_NAME_FLAG" ]]; then
			SSH_KEY_NAME="$SSH_KEY_NAME_FLAG"
			echo "SSH Key Name: $SSH_KEY_NAME (from --ssh-key)"
		else
			echo "Which of the following SSH Keys was attached to the database droplet?"
			echo "(Only keys that also exist on this computer — ~/.ssh or ssh-agent — are listed.)"
			LOCAL_DO_KEYS=$("$OPS_DIR/create.sh" --list-ssh-keys)
			if [[ -z "$LOCAL_DO_KEYS" ]]; then
				echo "No DigitalOcean SSH keys match a key on this machine."
				echo "Add this PC's public key to the droplet (and the DigitalOcean account), or re-run with --backup=no."
				exit 1
			fi
			printf '%s\n' "$LOCAL_DO_KEYS"
			read -p "SSH Key Name: " SSH_KEY_NAME
		fi
		if [[ -z "$SSH_KEY_NAME" ]]; then
			echo "SSH Key Name not provided"
			exit 1
		fi

		# grep -c exits 1 (a "failure" under set -e) when it counts zero
		# matches, even though it prints "0" correctly — every grep -c here is
		# `|| true`'d so a zero count is reported, not treated as a
		# script-aborting error.
		SSH_KEY_MATCHES=$(doctl compute ssh-key list --format=ID,Name --no-header | grep "$SSH_KEY_NAME" || true)
		SSH_KEY_MATCH_COUNT=$(printf '%s\n' "$SSH_KEY_MATCHES" | grep -c '.' || true)
		if [[ "$SSH_KEY_MATCH_COUNT" -eq 0 ]]; then
			echo "SSH Key ID not found"
			[[ -n "$SSH_KEY_NAME_FLAG" ]] && exit 1
			continue
		elif [[ "$SSH_KEY_MATCH_COUNT" -eq 1 ]]; then
			SSH_KEY_ID=$(printf '%s\n' "$SSH_KEY_MATCHES" | cut -d ' ' -f 1)
			SSH_KEY_RESOLVED_NAME=$(printf '%s\n' "$SSH_KEY_MATCHES" | awk '{print $2}')
			break
		fi

		# SSH_KEY_NAME matched more than one key as a substring (e.g. "foo"
		# also matching "foo-bar") — only proceed if exactly one match is the
		# exact name typed. Otherwise we'd pick an arbitrary ID (or mash
		# several together) and pin ssh to the wrong local identity.
		SSH_KEY_EXACT=$(printf '%s\n' "$SSH_KEY_MATCHES" | awk -v name="$SSH_KEY_NAME" '$2 == name')
		SSH_KEY_EXACT_COUNT=$(printf '%s\n' "$SSH_KEY_EXACT" | grep -c '.' || true)
		if [[ "$SSH_KEY_EXACT_COUNT" -eq 1 ]]; then
			SSH_KEY_ID=$(printf '%s\n' "$SSH_KEY_EXACT" | cut -d ' ' -f 1)
			SSH_KEY_RESOLVED_NAME=$(printf '%s\n' "$SSH_KEY_EXACT" | awk '{print $2}')
			break
		fi

		echo "\"$SSH_KEY_NAME\" matches more than one SSH key:"
		printf '%s\n' "$SSH_KEY_MATCHES"
		if [[ -n "$SSH_KEY_NAME_FLAG" ]]; then
			echo "Be more specific with --ssh-key."
			exit 1
		fi
		echo "Type one of the names above exactly."
	done

	if ! "$OPS_DIR/create.sh" --list-ssh-keys | grep -qxF "$SSH_KEY_RESOLVED_NAME"; then
		echo "DigitalOcean SSH key \"$SSH_KEY_RESOLVED_NAME\" is not on this machine (no matching ~/.ssh/*.pub or ssh-agent identity)."
		echo "Copy the private key here, or re-run with --backup=no."
		exit 1
	fi

	# Pin ssh/scp to the local identity that matches this DigitalOcean public
	# key. ssh will otherwise try every key in the agent; with two similar
	# names that can exhaust MaxAuthTries before the one actually on the
	# droplet is offered. Prefer a matching ~/.ssh private key; if the private
	# key is only in the agent, a tempfile of the public key is enough for
	# OpenSSH to select it.
	SSH_KEY_PUB=$(doctl compute ssh-key get "$SSH_KEY_ID" --format=PublicKey --no-header)
	SSH_KEY_BLOB=$(printf '%s\n' "$SSH_KEY_PUB" | awk '{print $2}')
	if [[ -z "$SSH_KEY_BLOB" ]]; then
		echo "Could not read public key for SSH key ID $SSH_KEY_ID"
		exit 1
	fi
	SSH_IDENTITY=""
	for pub in "$HOME"/.ssh/*.pub; do
		[[ -f "$pub" ]] || continue
		if [[ "$(awk '{print $2}' "$pub")" == "$SSH_KEY_BLOB" ]]; then
			ident="${pub%.pub}"
			if [[ -f "$ident" ]]; then
				SSH_IDENTITY="$ident"
				break
			fi
		fi
	done
	if [[ -z "$SSH_IDENTITY" ]]; then
		SSH_IDENTITY_TEMP=$(mktemp)
		printf '%s\n' "$SSH_KEY_PUB" > "$SSH_IDENTITY_TEMP"
		chmod 600 "$SSH_IDENTITY_TEMP"
		SSH_IDENTITY="$SSH_IDENTITY_TEMP"
	fi
	echo "Using SSH identity $SSH_IDENTITY"

	echo "----------------------------------------"
	echo "Backing Up Database..."

	mkdir -p "$BACKUP_DIR"
	BACKUP_SQL_PATH="$BACKUP_DIR/$(date +%Y%m%d%H%M%S)_backup_${APP_NAME}.sql"

	DROPLET_IP=$(doctl compute droplet list --format=PublicIPv4,Name --no-header | grep "$DROPLET_NAME" | cut -d ' ' -f 1)
	if [[ -z "$DROPLET_IP" ]]; then
		echo "Droplet IP not found"
		exit 1
	fi

	# BatchMode so a missing key fails immediately instead of hanging on a
	# password prompt the GUI has no TTY to answer. IdentitiesOnly so
	# ssh-agent cannot offer a different similarly-named key first.
	SSH_OPTS=(
		-o BatchMode=yes
		-o StrictHostKeyChecking=no
		-o IdentitiesOnly=yes
		-i "$SSH_IDENTITY"
	)
	# Unlike delete.sh the database is live here (the app is still serving),
	# so --single-transaction takes a consistent InnoDB snapshot instead of
	# read-locking every table and stalling the game while the dump runs.
	set +e
	ssh "${SSH_OPTS[@]}" root@"$DROPLET_IP" "mariadb-dump --single-transaction --order-by-primary $DB_NAME | sed -e 's/DEFINER[ ]*=[ ]*[^*]*\*/\*/' > /root/backup.sql"
	SSH_STATUS=$?
	set -e
	if [ "$SSH_STATUS" -ne 0 ]; then
		echo "SSH to root@$DROPLET_IP failed (exit $SSH_STATUS) with DigitalOcean key \"$SSH_KEY_NAME\"."
		echo "Use the same SSH key that was attached when the droplet was created."
		echo "Nothing was deployed. Re-run with --backup=no to redeploy without a backup."
		exit 1
	fi
	scp "${SSH_OPTS[@]}" root@"$DROPLET_IP":/root/backup.sql "$BACKUP_SQL_PATH" >/dev/null 2>&1

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

	# Only the encrypted copy is kept: this is a dump of the live database,
	# and nothing needs the plaintext once the .gpg exists.
	rm -f "$BACKUP_SQL_PATH"

	echo "Database Backed Up: $BACKUP_GPG_PATH"
fi

################################################################################
# redeploy app
#
# create-deployment builds the latest commit of the app's branch and rolls it
# out; the app spec (env vars, size, branch) is left exactly as create.sh set
# it. --wait returns once the deployment is active or has failed, and fails
# with it, so set +e lets a failed rollout print what to do next instead of
# silently aborting.

echo "----------------------------------------"
echo "Redeploying App..."

DEPLOY_ARGS=(--wait)
if [[ "$FORCE_REBUILD" -eq 1 ]]; then
	DEPLOY_ARGS+=(--force-rebuild)
fi

set +e
doctl apps create-deployment "$APP_ID" "${DEPLOY_ARGS[@]}"
DEPLOY_STATUS=$?
set -e

if [ "$DEPLOY_STATUS" -ne 0 ]; then
	echo "----------------------------------------"
	echo "Redeploy failed (exit $DEPLOY_STATUS)."
	echo "App Platform keeps serving the previous version. If the new build crashed on"
	echo "startup, a failed schema migration is the usual cause — recent run logs:"
	FAILED_DEPLOYMENT_ID=$(doctl apps list-deployments "$APP_ID" --format=ID --no-header | head -n 1)
	if [[ -n "$FAILED_DEPLOYMENT_ID" ]]; then
		doctl apps logs "$APP_ID" "$APP_NAME" --deployment "$FAILED_DEPLOYMENT_ID" --type=run --tail=50 || true
	fi
	if [[ -n "$BACKUP_GPG_PATH" ]]; then
		echo "Pre-redeploy backup: $BACKUP_GPG_PATH"
	fi
	exit 1
fi

APP_URL=$(doctl apps get "$APP_ID" --format=DefaultIngress --no-header)
echo "App Redeployed"
echo "App URL: $APP_URL"

################################################################################

exit 0
