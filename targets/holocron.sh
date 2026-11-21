#!/usr/bin/env bash
################################################################################
# "holocron" deploy target: run a gameshell-framework game on the always-on home
# server (a Debian box with Docker) instead of DigitalOcean.
#
# This file is SOURCED by create.sh / delete.sh / redeploy.sh (and run by
# funnel.sh) when games/APP_NAME/deploy.conf sets TARGET=holocron. It is never
# run on its own. Without TARGET (or TARGET=digitalocean) none of this is read
# and the DigitalOcean path is untouched.
#
# What it drives on the box (the box's own repo, gerp93/Holocron, installs the
# shared database; see its services/mariadb/):
#   - one shared MariaDB container, "gameshell_mariadb", on the Docker network
#     "gameshell-db" (no published ports), one database + one user per game;
#   - one container per game, "game_APP_NAME", built ON THE BOX from the game's
#     public GitHub repo (its own Dockerfile), limited to HOLOCRON_CPUS cpus and
#     HOLOCRON_MEMORY, published on HOLOCRON_BIND:HOLOCRON_HOST_PORT only;
#   - /etc/holocron/games/APP_NAME.env (mode 0600, root): the game's env vars,
#     with a database password generated ON THE BOX and never printed;
#   - Tailscale Funnel only through funnel.sh, and only when the operator runs it.
#
# deploy.conf values this target reads (all optional unless noted):
#   TARGET=holocron           selects this target (default: digitalocean)
#   HOLOCRON_HOST_PORT        REQUIRED. Port on the box the game is published on
#                             (one per game, 1024-65535, never 2283 (Immich) or 8080 (housed))
#   HOLOCRON_FUNNEL_PORT      443, 8443 or 10000: the only ports Tailscale Funnel
#                             allows; only funnel.sh uses it. One game per port.
#   HOLOCRON_BIND             127.0.0.1 (default) or 0.0.0.0 (also on the LAN/tailnet)
#   HOLOCRON_CPUS             default 1
#   HOLOCRON_MEMORY           default 512m
# plus the usual APP_NAME, ENV_VAR_PREFIX, DB_NAME, HTTP_PORT, GIT_REPO,
# GIT_UPSTREAM, GIT_BRANCH, EXTRA_ENV_VARS.
#
# The ssh target (user@host) is never stored in this repo: it is
# HOLOCRON_SSH_TARGET from the environment, or DEPLOY_TARGET from
# ~/.config/kvguzzler/deploy.env (override the path with HOLOCRON_ENV_FILE).
# HOLOCRON_SSH names the ssh program to use (default: ssh). The GUI on Windows sets it
# to the Windows OpenSSH client (ssh.exe) so the scripts, which run inside WSL there,
# use the same keys and agent as the rest of the PC instead of needing their own.
#
# Operator secrets: GPG_PASSPHRASE (optional, same as the DigitalOcean path) and,
# for EXTRA_ENV_VARS, the named variables in the environment. DEPLOY_SQL_USER /
# DEPLOY_SQL_PASSWORD are not used here: the box generates each game's database
# password itself.
#
# Backups are the same GPG-encrypted games/APP_NAME/backups/*.sql.gpg files.
# Restore decrypts on this machine and pipes straight into MariaDB (no decrypted
# copy on disk here); a dump is written root-only on the box for the length of
# the checks and the transfer, then removed.
################################################################################

HL_GAMES_DIR=/var/lib/holocron-games # build sources and transient dumps on the box
HL_ENV_DIR=/etc/holocron/games       # per-game env files on the box (0600, root)
HL_DB_CONTAINER=gameshell_mariadb
HL_DB_NETWORK=gameshell-db
HL_REPO_DEFAULT_IMAGE_PREFIX=holocron-game

hl_say() { printf '%s\n' "$*"; }
hl_divider() {
	echo "----------------------------------------"
	[[ $# -gt 0 ]] && echo "$*"
	return 0
}
hl_die() {
	echo "$*" >&2
	exit 1
}

################################################################################
# config + ssh target

hl_load() {
	: "${APP_NAME:?deploy.conf must set APP_NAME}"
	: "${ENV_VAR_PREFIX:?deploy.conf must set ENV_VAR_PREFIX}"
	: "${DB_NAME:?deploy.conf must set DB_NAME}"
	: "${HTTP_PORT:?deploy.conf must set HTTP_PORT}"
	: "${GIT_REPO:?deploy.conf must set GIT_REPO}"
	: "${HOLOCRON_HOST_PORT:?deploy.conf must set HOLOCRON_HOST_PORT for TARGET=holocron}"

	HOLOCRON_BIND="${HOLOCRON_BIND:-127.0.0.1}"
	HOLOCRON_CPUS="${HOLOCRON_CPUS:-1}"
	HOLOCRON_MEMORY="${HOLOCRON_MEMORY:-512m}"
	HOLOCRON_FUNNEL_PORT="${HOLOCRON_FUNNEL_PORT:-}"

	# Everything below ends up in a remote shell script, so each value is
	# checked against a strict pattern first rather than quoted and trusted.
	[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || hl_die "APP_NAME must be lowercase letters, digits and dashes: $APP_NAME"
	[[ "$ENV_VAR_PREFIX" =~ ^[A-Z][A-Z0-9_]*$ ]] || hl_die "ENV_VAR_PREFIX must be UPPER_SNAKE_CASE: $ENV_VAR_PREFIX"
	[[ "$DB_NAME" =~ ^[A-Za-z][A-Za-z0-9_]{0,47}$ ]] || hl_die "DB_NAME must be letters, digits and underscores: $DB_NAME"
	[[ "$HTTP_PORT" =~ ^[0-9]{2,5}$ ]] || hl_die "HTTP_PORT must be a number: $HTTP_PORT"
	[[ "$GIT_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || hl_die "GIT_REPO must be owner/name: $GIT_REPO"
	[[ -z "${GIT_UPSTREAM:-}" || "$GIT_UPSTREAM" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || hl_die "GIT_UPSTREAM must be owner/name: $GIT_UPSTREAM"
	[[ "$HOLOCRON_HOST_PORT" =~ ^[0-9]{4,5}$ ]] && [ "$HOLOCRON_HOST_PORT" -ge 1024 ] && [ "$HOLOCRON_HOST_PORT" -le 65535 ] ||
		hl_die "HOLOCRON_HOST_PORT must be a port from 1024 to 65535: $HOLOCRON_HOST_PORT"
	case "$HOLOCRON_HOST_PORT" in
		2283 | 8080 | 22 | 3306) hl_die "HOLOCRON_HOST_PORT $HOLOCRON_HOST_PORT is used by something else on the box (Immich, housed, ssh, MariaDB). Pick another." ;;
	esac
	[[ "$HOLOCRON_BIND" == "127.0.0.1" || "$HOLOCRON_BIND" == "0.0.0.0" ]] || hl_die "HOLOCRON_BIND must be 127.0.0.1 or 0.0.0.0: $HOLOCRON_BIND"
	[[ "$HOLOCRON_CPUS" =~ ^[0-9]+(\.[0-9]+)?$ ]] || hl_die "HOLOCRON_CPUS must be a number: $HOLOCRON_CPUS"
	[[ "$HOLOCRON_MEMORY" =~ ^[0-9]+[mMgG]$ ]] || hl_die "HOLOCRON_MEMORY must look like 512m or 1g: $HOLOCRON_MEMORY"
	if [[ -n "$HOLOCRON_FUNNEL_PORT" ]]; then
		[[ "$HOLOCRON_FUNNEL_PORT" =~ ^(443|8443|10000)$ ]] || hl_die "HOLOCRON_FUNNEL_PORT must be 443, 8443 or 10000 (the only ports Funnel allows): $HOLOCRON_FUNNEL_PORT"
	fi
	if [[ -n "${GIT_BRANCH:-}" ]]; then
		[[ "$GIT_BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$GIT_BRANCH" != -* ]] || hl_die "GIT_BRANCH has characters this target does not accept: $GIT_BRANCH"
	fi

	HL_CONTAINER="game_$APP_NAME"
	HL_IMAGE="$HL_REPO_DEFAULT_IMAGE_PREFIX/$APP_NAME"
	HL_ENV_FILE="$HL_ENV_DIR/$APP_NAME.env"
	HL_DB_USER="app_${APP_NAME//-/_}"
	GIT_REPO_URL="https://github.com/$GIT_REPO.git"
	BACKUP_DIR="$GAME_CONFIG_DIR/backups"

	local target="${HOLOCRON_SSH_TARGET:-}"
	if [[ -z "$target" ]]; then
		local envfile="${HOLOCRON_ENV_FILE:-$HOME/.config/kvguzzler/deploy.env}"
		if [[ -f "$envfile" ]]; then
			target=$(sed -n 's/^DEPLOY_TARGET=//p' "$envfile" | tr -d '"\r' | head -n 1)
		fi
	fi
	[[ -n "$target" ]] || hl_die "No ssh target for the box. Set HOLOCRON_SSH_TARGET=user@host, or DEPLOY_TARGET in ~/.config/kvguzzler/deploy.env."
	[[ "$target" =~ ^[A-Za-z0-9._@:-]+$ && "$target" != -* ]] || hl_die "The ssh target has characters this target does not accept."
	HL_SSH_TARGET="$target"
	HL_SSH="${HOLOCRON_SSH:-ssh}"
	HL_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=20)
}

################################################################################
# running things on the box
#
# Scripts go over as base64 inside one ssh argument ("bash -c <decoded>"), so
# no quoting survives a trip through a shell on either side and stdin stays free
# for data (a backup being restored, secret values). The script gets the
# validated values as plain shell variables from hl_prelude; secrets never go in
# the script, only on stdin.

hl_prelude() {
	printf 'APP=%q\nDB=%q\nPREFIX=%q\nHTTP_PORT=%q\nHP=%q\nBIND=%q\nCPUS=%q\nMEM=%q\n' \
		"$APP_NAME" "$DB_NAME" "$ENV_VAR_PREFIX" "$HTTP_PORT" "$HOLOCRON_HOST_PORT" "$HOLOCRON_BIND" "$HOLOCRON_CPUS" "$HOLOCRON_MEMORY"
	printf 'CONTAINER=%q\nIMAGE=%q\nENVF=%q\nDBUSER=%q\nREPO_URL=%q\nBRANCH=%q\n' \
		"$HL_CONTAINER" "$HL_IMAGE" "$HL_ENV_FILE" "$HL_DB_USER" "$GIT_REPO_URL" "${GIT_BRANCH:-}"
	printf 'GAMES_DIR=%q\nENV_DIR=%q\nDBC=%q\nDBNET=%q\n' "$HL_GAMES_DIR" "$HL_ENV_DIR" "$HL_DB_CONTAINER" "$HL_DB_NETWORK"
	cat <<'EOF'
set -euo pipefail
# The shared MariaDB's root login: the password comes from inside the container's own environment, never from an argument.
msql() { sudo docker exec -i "$DBC" sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot "$@"' sh "$@"; }
msqlq() { msql "$@" </dev/null; } # a query given with -e: never let docker exec wait on or swallow the caller stdin
mdump() { sudo docker exec -i "$DBC" sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot "$@"' sh "$@"; }
EOF
}

# hl_remote 'script text' — extra args are not accepted; use variables from hl_prelude.
hl_remote() {
	local b64
	b64=$({
		hl_prelude
		printf '%s\n' "$1"
	} | base64 | tr -d '\n')
	"$HL_SSH" "${HL_SSH_OPTS[@]}" "$HL_SSH_TARGET" "bash -c \"\$(printf %s $b64 | base64 -d)\""
}

################################################################################
# gpg on this machine (same passphrase handling as the DigitalOcean path)

hl_gpg_decrypt() { # file -> plaintext on stdout
	if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
		gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 -d "$1" 3<<< "$GPG_PASSPHRASE"
	else
		gpg -d "$1"
	fi
}

hl_gpg_encrypt() { # plaintext on stdin -> file
	if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
		gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 -c --output "$1" 3<<< "$GPG_PASSPHRASE"
	else
		gpg -c --output "$1"
	fi
}

# Confirms a .gpg backup decrypts and is a complete dump (MariaDB writes
# "-- Dump completed on" as its last line), streaming so nothing lands on disk.
hl_verify_backup() {
	local last
	last=$(hl_gpg_decrypt "$1" | tail -n 1) || return 1
	[[ "$last" =~ ^"-- Dump completed on " ]]
}

################################################################################
# git (all on this machine; the box clones the game repo itself)

hl_resolve_branch() {
	hl_divider
	if [[ -z "${GIT_BRANCH:-}" ]]; then
		# -C /: ls-remote only needs the URL; running it from inside a checkout (a git worktree seen from WSL, say) can fail on that checkout itself.
		GIT_BRANCH=$(git -C / ls-remote --symref "$GIT_REPO_URL" HEAD | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#\1#p')
		[[ -n "$GIT_BRANCH" ]] || hl_die "could not determine the default branch of $GIT_REPO — set GIT_BRANCH in deploy.conf"
		[[ "$GIT_BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$GIT_BRANCH" != -* ]] || hl_die "default branch name has characters this target does not accept: $GIT_BRANCH"
		echo "Deploying Branch: $GIT_BRANCH (default branch of $GIT_REPO)"
	else
		git -C / ls-remote --exit-code --heads "$GIT_REPO_URL" "$GIT_BRANCH" >/dev/null 2>&1 ||
			hl_die "Branch not found in $GIT_REPO: $GIT_BRANCH (fix GIT_BRANCH in games/$APP_NAME_ARG/deploy.conf, or leave it blank for the default branch)"
		echo "Deploying Branch: $GIT_BRANCH (from deploy.conf)"
	fi
}

hl_fork_sync() {
	[[ -n "${GIT_UPSTREAM:-}" && "$GIT_UPSTREAM" != "$GIT_REPO" ]] || return 0
	hl_divider "Checking Fork Sync ($GIT_REPO vs $GIT_UPSTREAM, branch $GIT_BRANCH)..."
	local upstream_url="https://github.com/$GIT_UPSTREAM.git" dir commits confirm
	dir=$(mktemp -d)
	(
		cd "$dir"
		git init -q
		git fetch -q "$GIT_REPO_URL" "$GIT_BRANCH":origin-head
		git fetch -q "$upstream_url" "$GIT_BRANCH":upstream-head
		commits=$(git log origin-head..upstream-head --oneline)
		if [[ -z "$commits" ]]; then
			echo "Fork is up to date with upstream."
		else
			echo "The following commits will be pushed from $GIT_UPSTREAM to $GIT_REPO:"
			echo "$commits"
			if [[ "${AUTO_YES:-0}" -eq 1 ]]; then
				echo "Auto-confirming push (--yes)"
				git push "$GIT_REPO_URL" upstream-head:"$GIT_BRANCH"
			else
				read -r -p "Do you want to continue with the push? (y/N): " confirm
				if [[ "$confirm" =~ ^[Yy]$ ]]; then
					git push "$GIT_REPO_URL" upstream-head:"$GIT_BRANCH"
				else
					echo "Push cancelled by user. Exiting script."
					exit 1
				fi
			fi
			echo "Fork Synced"
		fi
	) || {
		rm -rf "$dir"
		exit 1
	}
	rm -rf "$dir"
}

################################################################################
# the box

# Read-only: ssh works, sudo works without a password, Docker and git are there,
# the shared database is up, and (unless EXPECT_FREE_PORT=0) the port is free.
hl_preflight() {
	hl_divider "Checking the box..."
	if ! hl_remote '
		sudo -n true || { echo "passwordless sudo is not set up for this user" >&2; exit 10; }
		command -v git >/dev/null || { echo "git is not installed on the box" >&2; exit 10; }
		sudo docker version >/dev/null || { echo "Docker is not running on the box" >&2; exit 10; }
		state=$(sudo docker inspect -f "{{.State.Health.Status}}" "$DBC" 2>/dev/null || true)
		if [ "$state" != "healthy" ]; then
			echo "The shared database container ($DBC) is not running/healthy (state: ${state:-missing})." >&2
			echo "Install it from the box'"'"'s Holocron repo: sudo ./bootstrap.sh (services/mariadb/)." >&2
			exit 11
		fi
		sudo docker network inspect "$DBNET" >/dev/null || { echo "Docker network $DBNET is missing" >&2; exit 11; }
		echo "Box OK: Docker up, shared database healthy."
	'; then
		hl_die "The box is not ready (see above)."
	fi
}

hl_port_free_check() {
	hl_remote '
		if ss -ltn "sport = :$HP" | grep -q LISTEN; then
			echo "Port $HP is already in use on the box. Pick another HOLOCRON_HOST_PORT in deploy.conf." >&2
			exit 12
		fi
	' || hl_die "HOLOCRON_HOST_PORT is taken."
}

# Resolves EXTRA_ENV_VARS from the environment into HL_EXTRA_LINES
# (newline-separated KEY=VALUE). Same naming rules as create.sh.
hl_resolve_extra_env() {
	HL_EXTRA_LINES=""
	# The GUI passes the values in a 0600 YAML file instead of the environment (the
	# same shape create.sh splices into the DigitalOcean app spec); read KEY=VALUE
	# lines out of it. Values are double-quoted YAML scalars with \ and \" escaped.
	if [[ -n "${EXTRA_ENV_YAML_FILE:-}" ]]; then
		[[ -f "$EXTRA_ENV_YAML_FILE" ]] || hl_die "EXTRA_ENV_YAML_FILE not found: $EXTRA_ENV_YAML_FILE"
		local ykey="" yline yval bs='\' dq='"'
		while IFS= read -r yline || [[ -n "$yline" ]]; do
			yline="${yline%$'\r'}"
			if [[ "$yline" =~ ^"  - key: "([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
				ykey="${BASH_REMATCH[1]}"
			elif [[ -n "$ykey" && "$yline" == '    value: "'* && "$yline" == *'"' ]]; then
				yval="${yline#'    value: "'}"
				yval="${yval%'"'}"
				# Undo the YAML escaping (two backslashes -> one, backslash-quote -> quote); a placeholder
				# keeps an escaped backslash followed by a quote from being misread.
				yval="${yval//"$bs$bs"/$'\001'}"
				yval="${yval//"$bs$dq"/$dq}"
				yval="${yval//$'\001'/$bs}"
				HL_EXTRA_LINES+="$ykey=$yval"$'\n'
				echo "  extra env: $ykey"
				ykey=""
			fi
		done < "$EXTRA_ENV_YAML_FILE"
		return 0
	fi
	local list="${EXTRA_ENV_VARS:-}" token name key val
	list="${list//,/ }"
	[[ -n "${list// }" ]] || return 0
	for token in $list; do
		if [[ "$token" == +* ]]; then
			name="${token#+}"
			[[ -n "$name" ]] || hl_die "Invalid EXTRA_ENV_VARS name: +"
			key="${ENV_VAR_PREFIX}_${name}"
		else
			key="$token"
		fi
		[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || hl_die "Invalid EXTRA_ENV_VARS name: $token (resolves to $key)"
		val="${!key:-}"
		[[ -n "$val" ]] || hl_die "Environment variable not found: $key (set it in the environment; deploy.conf lists the name only)"
		[[ "$val" != *$'\n'* && "$val" != *$'\r'* ]] || hl_die "Environment variable $key contains a newline; refusing to write it to an env file."
		HL_EXTRA_LINES+="$key=$val"$'\n'
		echo "  extra env: $key"
	done
}

# Builds (or rebuilds) the game image on the box and starts the container.
# $1 = 1 to bypass the build cache. On success prints the commit that was built.
hl_build_and_run() {
	local nocache="${1:-0}"
	hl_divider "Building $APP_NAME on the box (low priority, 1 CPU cap; this is slow on a small box)..."
	NOCACHE_FLAG=""
	[[ "$nocache" -eq 1 ]] && NOCACHE_FLAG="--no-cache"
	hl_remote "
		NOCACHE='$NOCACHE_FLAG'
		export GIT_TERMINAL_PROMPT=0
		SRC=\"\$GAMES_DIR/\$APP/src\"
		sudo install -d -m 755 \"\$GAMES_DIR\"
		sudo install -d -o \"\$(id -un)\" -m 755 \"\$GAMES_DIR/\$APP\"
		if [ -d \"\$SRC/.git\" ]; then
			git -C \"\$SRC\" remote set-url origin \"\$REPO_URL\"
			git -C \"\$SRC\" fetch -q --depth 1 origin \"\$BRANCH\"
			git -C \"\$SRC\" reset -q --hard FETCH_HEAD
			git -C \"\$SRC\" clean -fdq
		else
			rm -rf \"\$SRC\"
			git clone -q --depth 1 --branch \"\$BRANCH\" \"\$REPO_URL\" \"\$SRC\"
		fi
		SHA=\$(git -C \"\$SRC\" rev-parse HEAD)
		echo \"Source commit: \${SHA:0:12}\"
		if sudo docker image inspect \"\$IMAGE:latest\" >/dev/null 2>&1; then
			sudo docker tag \"\$IMAGE:latest\" \"\$IMAGE:previous\"
		fi
		# nice/ionice only slow the docker client; the cpu flags are what actually keep the build from starving the house server.
		sudo nice -n 19 ionice -c3 docker build --progress=plain \$NOCACHE \\
			--cpu-period=100000 --cpu-quota=100000 --cpu-shares=128 --memory=1536m \\
			--label org.holocron.commit=\"\$SHA\" -t \"\$IMAGE:latest\" -t \"\$IMAGE:\${SHA:0:12}\" \"\$SRC\"
		echo \"Image Built\"
	" || return 1
}

hl_run_container() {
	hl_remote '
		SHA=$(git -C "$GAMES_DIR/$APP/src" rev-parse HEAD)
		sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
		sudo docker run -d --name "$CONTAINER" --restart unless-stopped --network "$DBNET" \
			-p "$BIND:$HP:$HTTP_PORT" --env-file "$ENVF" \
			--cpus "$CPUS" --cpu-shares 256 --memory "$MEM" --memory-swap "$MEM" --pids-limit 512 \
			--cap-drop ALL --security-opt no-new-privileges \
			--label org.holocron.app="$APP" --label org.holocron.commit="$SHA" \
			"$IMAGE:latest" >/dev/null
		code=000
		for i in $(seq 1 30); do
			if [ "$(sudo docker inspect -f "{{.State.Running}}" "$CONTAINER" 2>/dev/null)" != "true" ]; then break; fi
			code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:$HP/" || true)
			case "$code" in 2??|3??|4??) echo "Game answers on port $HP (HTTP $code)"; exit 0 ;; esac
			sleep 2
		done
		echo "The game did not answer (last HTTP code $code). Its recent log:" >&2
		sudo docker logs --tail 40 "$CONTAINER" >&2 || true
		exit 13
	'
}

# Removes everything the box holds for this game: container, images, build
# sources, env file, database and database user. Used by delete and to roll back
# a create that failed halfway. Tolerant on purpose: each piece may be missing.
hl_remove_everything() {
	hl_remote '
		set +e
		sudo docker rm -f "$CONTAINER" >/dev/null 2>&1
		sudo docker image ls -q "$IMAGE" | sort -u | xargs -r sudo docker image rm -f >/dev/null 2>&1
		msqlq -e "DROP DATABASE IF EXISTS \`$DB\`; DROP USER IF EXISTS '"'"'$DBUSER'"'"'@'"'"'%'"'"';"
		sudo rm -f "$ENVF"
		sudo rm -rf "$GAMES_DIR/$APP"
		echo "Removed container, images, sources, env file and database for $APP."
		exit 0
	'
}

################################################################################
# backups

# Dumps the game's database into games/APP_NAME/backups/*.sql.gpg and sets
# HL_BACKUP_GPG_PATH. $1 = 1 for a live database (--single-transaction snapshot).
# The dump is made as a root-only file on the box, checked there (the same five
# checks delete.sh/redeploy.sh make on a droplet), streamed through gpg here, and
# removed from the box; the plaintext never touches this machine's disk.
hl_backup_db() {
	local live="${1:-0}" stamp sqlname gpgpath
	stamp=$(date +%Y%m%d%H%M%S)
	sqlname="${stamp}_backup_${APP_NAME}.sql"
	mkdir -p "$BACKUP_DIR"
	gpgpath="$BACKUP_DIR/$sqlname.gpg"
	HL_BACKUP_GPG_PATH=""

	hl_divider "Backing Up Database..."
	if ! hl_remote "
		LIVE='$live'
		DUMP=\"\$GAMES_DIR/.dump-\$APP.sql\"
		sudo install -d -m 755 \"\$GAMES_DIR\"
		trap 'sudo rm -f \"\$DUMP\"' ERR
		umask 077
		FLAGS='--order-by-primary'
		[ \"\$LIVE\" = 1 ] && FLAGS='--single-transaction --order-by-primary'
		# DEFINER clauses are stripped at backup time: a stale one fails to restore onto a fresh server.
		mdump \$FLAGS \"\$DB\" | sed -e 's/DEFINER[ ]*=[ ]*[^*]*\\*/\\*/' | sudo tee \"\$DUMP\" >/dev/null
		sudo test -f \"\$DUMP\" || { echo 'Backup failed: backup file not found'; exit 1; }
		sudo test -s \"\$DUMP\" || { echo 'Backup failed: backup file is empty'; exit 1; }
		[ -z \"\$(sudo find \"\$DUMP\" -mmin +1 -print -quit)\" ] || { echo 'Backup failed: backup file is older than 1 minute'; exit 1; }
		size=\$(sudo stat -c%s \"\$DUMP\")
		[ \"\$size\" -ge 1024 ] || { echo 'Backup failed: backup file is too small'; exit 1; }
		last=\$(sudo tail -n 1 \"\$DUMP\")
		case \"\$last\" in '-- Dump completed on '*) ;; *) echo 'Backup failed: backup file does not appear to be valid'; exit 1 ;; esac
		echo \"Dump checked on the box (\$size bytes)\"
	"; then
		hl_remote 'sudo rm -f "$GAMES_DIR/.dump-$APP.sql"' >/dev/null 2>&1 || true
		return 1
	fi

	rm -f "$gpgpath"
	if ! { hl_remote 'DUMP="$GAMES_DIR/.dump-$APP.sql"; trap '"'"'sudo rm -f "$DUMP"'"'"' EXIT; sudo cat "$DUMP"' | hl_gpg_encrypt "$gpgpath"; }; then
		hl_remote 'sudo rm -f "$GAMES_DIR/.dump-$APP.sql"' >/dev/null 2>&1 || true
		rm -f "$gpgpath"
		echo "Backup failed: could not transfer and encrypt the dump"
		return 1
	fi
	if [[ ! -s "$gpgpath" ]]; then
		rm -f "$gpgpath"
		echo "Backup failed: encrypted file not written"
		return 1
	fi
	if ! hl_verify_backup "$gpgpath"; then
		rm -f "$gpgpath"
		echo "Backup failed: the encrypted file does not decrypt to a complete dump"
		return 1
	fi
	HL_BACKUP_GPG_PATH="$gpgpath"
	echo "Database Backed Up: $gpgpath"
}

hl_ask_backup() { # sets HL_DO_BACKUP=1|0
	local answer
	if [[ -n "${BACKUP_FLAG:-}" ]]; then
		answer=$([[ "$BACKUP_FLAG" == "no" ]] && echo "n" || echo "y")
		echo "Backup database? $answer (from --backup)"
	else
		read -r -p "Do you want to backup the database${1:-}? [Y/n]: " answer
	fi
	[[ "$answer" != "n" ]] && HL_DO_BACKUP=1 || HL_DO_BACKUP=0
}

################################################################################
# create

holocron_create() {
	if [[ "${LIST_TIERS:-0}" -eq 1 || "${LIST_REGIONS:-0}" -eq 1 ]]; then
		exit 0 # tiers and regions are a DigitalOcean notion; nothing to list here
	fi
	hl_load
	[[ -z "${PRICE_TIER_FLAG:-}${SSH_KEY_NAME_FLAG:-}${REGION_FLAG:-}" ]] || echo "Note: --tier/--ssh-key/--region are DigitalOcean options and are ignored for the holocron target."

	hl_resolve_extra_env
	hl_preflight
	hl_remote '
		! sudo test -e "$ENVF" || { echo "$APP already has an env file on the box: it is deployed (use redeploy.sh), or run delete.sh first." >&2; exit 20; }
		! sudo docker container inspect "$CONTAINER" >/dev/null 2>&1 || { echo "Container $CONTAINER already exists on the box." >&2; exit 20; }
		n=$(msqlq -N -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '"'"'$DB'"'"'")
		[ "$n" = 0 ] || { echo "Database $DB already exists in the shared MariaDB (another game or an earlier deploy). Use a different DB_NAME or run delete.sh first." >&2; exit 21; }
	' || hl_die "Not creating: see above."
	hl_port_free_check
	hl_resolve_branch
	hl_fork_sync

	# Newest backup, if any. Decrypted as a stream: first to prove it decrypts and is complete, then again into the database.
	local backup_gpg
	backup_gpg=$(ls "$BACKUP_DIR"/*.gpg 2>/dev/null | tail -n 1 || true)
	hl_divider
	if [[ -z "$backup_gpg" ]]; then
		echo "No *.gpg backup found in: $BACKUP_DIR (creating fresh database)"
	else
		echo "Checking backup $(basename "$backup_gpg")..."
		hl_verify_backup "$backup_gpg" || hl_die "Backup does not decrypt to a complete dump: $backup_gpg"
		echo "Backup OK"
	fi

	hl_divider "Creating Database and Env File..."
	if ! printf '%s' "${HL_EXTRA_LINES:-}" | hl_remote '
		EXTRA=$(cat)
		umask 077
		sudo install -d -m 700 /etc/holocron "$ENV_DIR"
		PW=$(python3 -c "import secrets; print(secrets.token_hex(24))")
		TMP=$(sudo mktemp "$ENV_DIR/.env.XXXXXX")
		{
			printf "%s_SQL_HOST=%s\n" "$PREFIX" "$DBC"
			printf "%s_SQL_USER=%s\n" "$PREFIX" "$DBUSER"
			printf "%s_SQL_PASSWORD=%s\n" "$PREFIX" "$PW"
			printf "%s_SQL_DATABASE=%s\n" "$PREFIX" "$DB"
			[ -z "$EXTRA" ] || printf "%s\n" "$EXTRA"
		} | sudo tee "$TMP" >/dev/null
		sudo chmod 600 "$TMP"
		sudo mv "$TMP" "$ENVF"
		msql <<SQL
CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE OR REPLACE USER '"'"'$DBUSER'"'"'@'"'"'%'"'"' IDENTIFIED BY '"'"'$PW'"'"';
GRANT ALL PRIVILEGES ON \`$DB\`.* TO '"'"'$DBUSER'"'"'@'"'"'%'"'"';
-- Every game runs SET GLOBAL EVENT_SCHEDULER = ON at startup (the framework'"'"'s settings.sql), and MariaDB has no
-- narrower privilege for that than SUPER. The DigitalOcean database user had ALL ON *.*, so this is still less.
GRANT SUPER ON *.* TO '"'"'$DBUSER'"'"'@'"'"'%'"'"';
SQL
		echo "Database and env file created (password generated on the box, not shown)"
	'; then
		hl_remove_everything || true
		hl_die "Creating the database failed; rolled back."
	fi

	if [[ -n "$backup_gpg" ]]; then
		hl_divider "Restoring Database from Backup..."
		set +e
		hl_gpg_decrypt "$backup_gpg" | hl_remote 'msql "$DB"'
		local restore_status=("${PIPESTATUS[@]}")
		set -e
		if [[ "${restore_status[0]}" -ne 0 || "${restore_status[1]}" -ne 0 ]]; then
			hl_remove_everything || true
			hl_die "Restoring the backup failed; rolled back (nothing is left on the box)."
		fi
		echo "Database Restored"
	else
		echo "Database Created (app will initialize schema on startup)"
	fi

	if ! hl_build_and_run "0"; then
		hl_remove_everything || true
		hl_die "Building the game failed; rolled back."
	fi
	hl_divider "Starting Container..."
	if ! hl_run_container; then
		hl_remove_everything || true
		hl_die "The game did not start; rolled back."
	fi

	hl_divider
	echo "Container: $HL_CONTAINER, on the box at $HOLOCRON_BIND:$HOLOCRON_HOST_PORT"
	if [[ -n "$HOLOCRON_FUNNEL_PORT" ]]; then
		echo "Not public yet. To expose it on the internet (Tailscale Funnel, port $HOLOCRON_FUNNEL_PORT): ./funnel.sh $APP_NAME on"
	else
		echo "Not public. Set HOLOCRON_FUNNEL_PORT in deploy.conf, then ./funnel.sh $APP_NAME on, to put it on the internet."
	fi
	exit 0
}

################################################################################
# delete

holocron_delete() {
	hl_load
	hl_divider "Deleting $APP_NAME from the box..."
	local present
	present=$(hl_remote '
		sudo docker container inspect "$CONTAINER" >/dev/null 2>&1 && echo container
		n=$(msqlq -N -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '"'"'$DB'"'"'" 2>/dev/null || echo 0)
		[ "$n" = 0 ] || echo database
		sudo test -e "$ENVF" && echo envfile
		exit 0
	' | tr -d '') || hl_die "Could not reach the box."
	if [[ -z "$present" ]]; then
		echo "Nothing to delete: no container, database or env file for $APP_NAME on the box."
		exit 0
	fi

	if grep -q '^database$' <<< "$present"; then
		hl_ask_backup ""
		if [[ "$HL_DO_BACKUP" -eq 1 ]]; then
			hl_backup_db 0 || hl_die "Backup failed; nothing was deleted."
		else
			echo "Skipping backup."
		fi
	else
		echo "No database for $APP_NAME in the shared MariaDB, nothing to back up."
	fi

	# Take it off the internet first if Funnel points at this game.
	if [[ -n "$HOLOCRON_FUNNEL_PORT" ]]; then
		hl_funnel_off_if_ours || true
	fi

	hl_divider "Removing Container, Database and Files..."
	hl_remove_everything
	echo "Deleted"
	exit 0
}

################################################################################
# redeploy

holocron_redeploy() {
	hl_load
	local deployed latest_url latest_sha state commits note

	if ! deployed=$(hl_remote 'sudo docker inspect -f "{{index .Config.Labels \"org.holocron.commit\"}}" "$CONTAINER" 2>/dev/null || true'); then
		hl_die "Could not reach the box."
	fi
	deployed="${deployed//[$'\r\n ']/}"
	if [[ -z "$deployed" ]]; then
		if [[ "${CHECK_ONLY:-0}" -eq 1 ]]; then
			printf 'REDEPLOY_CHECK\tno-app\t\t\t\t\t\n'
			exit 0
		fi
		hl_die "App not found on the box: $APP_NAME. Nothing to redeploy. Use ./create.sh $APP_NAME to deploy it first."
	fi
	hl_resolve_branch

	latest_url="$GIT_REPO_URL"
	[[ -n "${GIT_UPSTREAM:-}" && "$GIT_UPSTREAM" != "$GIT_REPO" ]] && latest_url="https://github.com/$GIT_UPSTREAM.git"
	HL_WORK=$(mktemp -d)
	trap 'rm -rf "$HL_WORK"' EXIT
	git -C "$HL_WORK" init -q

	if [[ "${CHECK_ONLY:-0}" -eq 1 ]]; then
		state="unknown"
		note=""
		commits=""
		latest_sha=$(git -C / ls-remote "$latest_url" "refs/heads/$GIT_BRANCH" 2>/dev/null | cut -f 1 | head -n 1)
		if [[ -z "$latest_sha" ]]; then
			note="could not read branch $GIT_BRANCH"
		elif [[ "$latest_sha" == "$deployed"* ]]; then
			state="current"
		elif git -C "$HL_WORK" fetch -q "$latest_url" "$GIT_BRANCH":new-head 2>/dev/null && git -C "$HL_WORK" fetch -q "$GIT_REPO_URL" "$deployed" 2>/dev/null; then
			commits=$(git -C "$HL_WORK" rev-list --count "$deployed..new-head")
			[[ "$commits" -gt 0 ]] && state="behind" || state="current"
		else
			state="behind"
			note="could not compare the commits"
		fi
		printf 'REDEPLOY_CHECK\t%s\t%s\t%s\t%s\t%s\t%s\n' "$state" "$deployed" "$latest_sha" "$commits" "$GIT_BRANCH" "$note"
		exit 0
	fi

	hl_preflight
	hl_fork_sync

	hl_divider "Checking Pending SQL Changes..."
	if git -C "$HL_WORK" fetch -q "$latest_url" "$GIT_BRANCH":new-head 2>/dev/null && git -C "$HL_WORK" fetch -q "$GIT_REPO_URL" "$deployed" 2>/dev/null; then
		local new_sha sqlhits confirm
		new_sha=$(git -C "$HL_WORK" rev-parse new-head)
		if [[ "$deployed" == "$new_sha" ]]; then
			echo "Deployed commit ${deployed:0:7} is already the latest on $GIT_BRANCH; no new SQL."
		else
			echo "Deployed ${deployed:0:7} -> latest ${new_sha:0:7}"
			# Same heuristic as redeploy.sh: only added destructive lines count, comments are ignored.
			sqlhits=$(git -C "$HL_WORK" diff -U0 --no-color "$deployed" new-head -- '*.sql' | awk '
				/^\+\+\+ / { file = substr($0, 7); next }
				/^\+/ {
					line = substr($0, 2)
					if (line ~ /^[ \t]*--/) next
					u = toupper(line)
					if (u ~ /DROP[ \t]+(COLUMN|TABLE|INDEX|KEY|CONSTRAINT|FOREIGN)/ || u ~ /TRUNCATE/ || u ~ /^[ \t]*(DELETE|UPDATE)[ \t]/ || u ~ /[ \t](MODIFY|CHANGE)[ \t]/) {
						print file ": " line
					}
				}
			')
			if [[ -z "$sqlhits" ]]; then
				echo "No destructive SQL added since the deployed commit."
			else
				echo "*** The new commits add SQL that removes or rewrites data/columns: ***"
				echo "$sqlhits" | sed 's/^/  /'
				echo "It runs against the live database on startup; the backup below is the only way back."
				if [[ "${AUTO_YES:-0}" -eq 1 ]]; then
					echo "Auto-confirming (--yes)"
				else
					read -r -p "Continue with the redeploy? (y/N): " confirm
					[[ "$confirm" =~ ^[Yy]$ ]] || hl_die "Aborted. Nothing was deployed."
				fi
			fi
		fi
	else
		echo "Could not fetch $GIT_BRANCH or the deployed commit from GitHub, skipping SQL check."
	fi

	hl_ask_backup " first"
	if [[ "$HL_DO_BACKUP" -eq 1 ]]; then
		hl_backup_db 1 || hl_die "Backup failed. Nothing was deployed. Re-run with --backup=no to redeploy without a backup."
	else
		echo "Skipping backup."
	fi

	if ! hl_build_and_run "${FORCE_REBUILD:-0}"; then
		hl_die "The build failed. The previous container is still running untouched."
	fi
	hl_divider "Restarting Container..."
	if ! hl_run_container; then
		echo "The new version did not start; putting the previous image back..." >&2
		hl_remote '
			if sudo docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
				sudo docker tag "$IMAGE:previous" "$IMAGE:latest"
				sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
				sudo docker run -d --name "$CONTAINER" --restart unless-stopped --network "$DBNET" \
					-p "$BIND:$HP:$HTTP_PORT" --env-file "$ENVF" \
					--cpus "$CPUS" --cpu-shares 256 --memory "$MEM" --memory-swap "$MEM" --pids-limit 512 \
					--cap-drop ALL --security-opt no-new-privileges --label org.holocron.app="$APP" "$IMAGE:latest" >/dev/null
				echo "Previous version is running again."
			else
				echo "No previous image to go back to." >&2
			fi
		' || true
		[[ -z "${HL_BACKUP_GPG_PATH:-}" ]] || echo "Pre-redeploy backup: $HL_BACKUP_GPG_PATH"
		hl_die "Redeploy failed."
	fi
	echo "App Redeployed"
	exit 0
}

################################################################################
# Tailscale Funnel (only ever run by funnel.sh, never by create/delete/redeploy,
# except that delete takes this game off Funnel first)

# The line "tailscale funnel status" prints for a published port mentions the
# proxy target, e.g. "|-- / proxy http://127.0.0.1:12016".
hl_funnel_off_if_ours() {
	hl_remote '
		if sudo tailscale funnel status 2>/dev/null | grep -q "127.0.0.1:$HP"; then
			FP="'"$HOLOCRON_FUNNEL_PORT"'"
			sudo tailscale funnel --https="$FP" off
			echo "Funnel port $FP turned off (it pointed at this game)."
		fi
	'
}

# Machine-readable state for the GUI (funnel.sh APP info): one tab-separated line,
#   HOLOCRON_INFO  app(running|stopped|absent)  database(yes|no)  created(RFC 3339 or empty)  funnel(yes|no)  funnel-url
# "app" is the game container; "database" is the game's database in the shared MariaDB.
holocron_info() {
	hl_load
	hl_remote '
		state=absent
		if sudo docker container inspect "$CONTAINER" >/dev/null 2>&1; then
			state=$(sudo docker inspect -f "{{if .State.Running}}running{{else}}stopped{{end}}" "$CONTAINER")
		fi
		db=no
		n=$(msqlq -N -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '"'"'$DB'"'"'" 2>/dev/null || echo 0)
		[ "$n" = 0 ] || db=yes
		created=$(sudo docker inspect -f "{{.Created}}" "$CONTAINER" 2>/dev/null || true)
		funnel=no
		furl=
		fs=$(sudo tailscale funnel status 2>/dev/null || true)
		if printf "%s
" "$fs" | grep -q "127.0.0.1:$HP"; then
			funnel=yes
			furl=$(printf "%s
" "$fs" | awk -v hp="127.0.0.1:$HP" '"'"'/^https:\/\// { u = $1 } index($0, hp) { print u; exit }'"'"')
		fi
		printf "HOLOCRON_INFO	%s	%s	%s	%s	%s
" "$state" "$db" "$created" "$funnel" "$furl"
	' | tr -d ''
}

holocron_funnel() { # $1 = on|off|status
	hl_load
	local action="$1" confirm
	case "$action" in
		status)
			hl_remote 'sudo tailscale funnel status 2>&1 || true; echo; echo "Ports used by games on this box:"; sudo docker ps --filter label=org.holocron.app --format "{{.Names}}  {{.Ports}}"'
			;;
		on)
			[[ -n "$HOLOCRON_FUNNEL_PORT" ]] || hl_die "Set HOLOCRON_FUNNEL_PORT (443, 8443 or 10000) in games/$APP_NAME_ARG/deploy.conf first."
			# One game per Funnel port: refuse if another holocron game's config claims the same one.
			local other other_target other_port
			for other in "$OPS_DIR"/games/*/deploy.conf; do
				[[ "$other" == "$GAME_CONFIG_DIR/deploy.conf" ]] && continue
				other_target=$(sed -n 's/^TARGET=//p' "$other" | tr -d "\"'\r" | head -n 1)
				other_port=$(sed -n 's/^HOLOCRON_FUNNEL_PORT=//p' "$other" | tr -d "\"'\r" | head -n 1)
				[[ "$other_target" == "holocron" && "$other_port" == "$HOLOCRON_FUNNEL_PORT" ]] &&
					hl_die "Funnel port $HOLOCRON_FUNNEL_PORT is also set for $(basename "$(dirname "$other")"). One game per port."
			done
			echo "This puts $APP_NAME on the public internet through Tailscale Funnel (https, port $HOLOCRON_FUNNEL_PORT) for anyone with the link."
			if [[ "${AUTO_YES:-0}" -ne 1 ]]; then
				read -r -p "Continue? (y/N): " confirm
				[[ "$confirm" =~ ^[Yy]$ ]] || hl_die "Not exposed."
			fi
			hl_remote '
				sudo docker container inspect "$CONTAINER" >/dev/null 2>&1 || { echo "$CONTAINER is not running; create it first." >&2; exit 30; }
				FP="'"$HOLOCRON_FUNNEL_PORT"'"
				sudo tailscale funnel --bg --https="$FP" "http://127.0.0.1:$HP"
			'
			;;
		off)
			[[ -n "$HOLOCRON_FUNNEL_PORT" ]] || hl_die "Set HOLOCRON_FUNNEL_PORT in games/$APP_NAME_ARG/deploy.conf first."
			hl_remote '
				FP="'"$HOLOCRON_FUNNEL_PORT"'"
				sudo tailscale funnel --https="$FP" off
				echo "Funnel port $FP is off."
			'
			;;
		*) hl_die "Usage: ./funnel.sh APP_NAME on|off|status" ;;
	esac
}
