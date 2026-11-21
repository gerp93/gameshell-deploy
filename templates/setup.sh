#!/bin/bash

dnf upgrade --refresh -y
dnf module enable mariadb:10.11 -y
dnf install mariadb-server -y

systemctl enable mariadb.service --now

mariadb -e "CREATE USER 'REPLACE_SQL_USER'@'%';"
mariadb -e "GRANT ALL PRIVILEGES ON _._ TO 'REPLACE_SQL_USER'@'%';"
mariadb -e "GRANT ALL PRIVILEGES ON *.* TO 'REPLACE_SQL_USER'@'%';"
mariadb -e "SET PASSWORD FOR 'REPLACE_SQL_USER'@'%' = PASSWORD('REPLACE_SQL_PASSWORD');"
mariadb -e "FLUSH PRIVILEGES;"
mariadb -e "CREATE DATABASE REPLACE_DB_NAME CHARACTER SET = 'UTF8MB4' COLLATE = 'UTF8MB4_UNICODE_CI';"

touch /root/.gameshell-setup-complete
