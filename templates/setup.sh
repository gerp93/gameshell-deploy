#!/bin/bash
set -e

# Don't `dnf upgrade --refresh` the whole image. On centos-stream that
# pulls hundreds of packages and is what made droplet setup take ~7 minutes
# before MariaDB even started installing. The DigitalOcean image is current
# enough to install mariadb-server.
#
# Don't poweroff when done either. create.sh used to wait for Status=off in
# 1-minute polls, then power the droplet back on — a full reboot after the
# already-slow upgrade. A sentinel file is the done signal instead.

if dnf module enable mariadb:10.11 -y; then
	:
fi
dnf install -y mariadb-server

systemctl enable mariadb.service --now

mariadb -e "CREATE USER 'REPLACE_SQL_USER'@'%';"
mariadb -e "GRANT ALL PRIVILEGES ON _._ TO 'REPLACE_SQL_USER'@'%';"
mariadb -e "GRANT ALL PRIVILEGES ON *.* TO 'REPLACE_SQL_USER'@'%';"
mariadb -e "SET PASSWORD FOR 'REPLACE_SQL_USER'@'%' = PASSWORD('REPLACE_SQL_PASSWORD');"
mariadb -e "FLUSH PRIVILEGES;"
mariadb -e "CREATE DATABASE REPLACE_DB_NAME CHARACTER SET = 'UTF8MB4' COLLATE = 'UTF8MB4_UNICODE_CI';"

touch /root/.gameshell-setup-complete
