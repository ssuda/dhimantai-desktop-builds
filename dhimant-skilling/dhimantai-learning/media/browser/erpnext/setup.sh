#!/usr/bin/env bash
set -euo pipefail
cd /home/frappe/frappe-bench
ls -1 apps > sites/apps.txt
bench set-config -g db_host db
bench set-config -gp db_port 3306
bench set-config -g redis_cache redis://redis-cache:6379
bench set-config -g redis_queue redis://redis-queue:6379
bench set-config -g redis_socketio redis://redis-queue:6379
bench set-config -gp socketio_port 9000
bench set-config -g webserver_host backend
bench set-config -gp webserver_port 8000
bench set-config -g enable_telemetry 0
if [ ! -f sites/frontend/site_config.json ]; then
  bench new-site --mariadb-user-host-login-scope='%' \
    --admin-password="$DHIMANTAI_ADMIN_PASSWORD" --db-root-username=root \
    --db-root-password="$MARIADB_ROOT_PASSWORD" --install-app erpnext --set-default frontend
fi
env/bin/python /opt/dhimantai/bootstrap.py
