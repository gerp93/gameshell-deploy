#!/usr/bin/env bash
################################################################################
# Delete instance of Card Judge in Digital Ocean
################################################################################

set -e # exit on any command error

APP_NAME="card-judge"

################################################################################
# get file paths

cd "$(dirname "$0")"
BACKUP_SQL_PATH="$(pwd)/../database/backup.sql"

################################################################################
# backup database

echo "----------------------------------------"
echo "Backing Up Database..."

DROPLET_NAME="$APP_NAME-database"
DROPLET_IP=$(doctl compute droplet list --format=PublicIPv4,Name --no-header | grep $DROPLET_NAME | cut -d ' ' -f 1)
if [[ -z "$DROPLET_IP" ]]; then
	echo "Droplet IP not found"
	exit 1
fi

ssh root@$DROPLET_IP 'mariadb-dump --order-by-primary CARD_JUDGE | sed -e '\''s/DEFINER[ ]*=[ ]*[^*]*\*/\*/'\'' > /root/backup.sql'
scp root@$DROPLET_IP:/root/backup.sql "$BACKUP_SQL_PATH" >/dev/null 2>&1

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
if (( filesize < 1024 )); then
	echo "Backup failed: backup file is too small"
	exit 1
fi

BACKUP_SQL_LAST_LINE=$(tail -n 1 "$BACKUP_SQL_PATH")
if ! [[ "$BACKUP_SQL_LAST_LINE" =~ ^"-- Dump completed on " ]]; then
	echo "Backup failed: backup file does not appear to be valid"
	exit 1
fi

echo "Database Backed Up"

################################################################################
# delete droplet

echo "----------------------------------------"
echo "Deleting Droplet..."

DROPLET_ID=$(doctl compute droplet list --format=ID,Name --no-header | grep $APP_NAME | cut -d ' ' -f 1)
if [[ -z "$DROPLET_ID" ]]; then
	echo "Droplet ID not found"
	exit 1
fi

doctl compute droplet delete $DROPLET_ID --force

echo "Droplet Deleted"

################################################################################
# delete app

echo "----------------------------------------"
echo "Deleting App..."

APP_ID=$(doctl apps list --format=ID,Spec.Name --no-header | grep $APP_NAME | cut -d ' ' -f 1)
if [[ -z "$APP_ID" ]]; then
	echo "App ID not found"
	exit 1
fi

doctl apps delete $APP_ID --force

echo "App Deleted"

################################################################################

exit 0
