#!/bin/sh
set -eu
[ "$#" -eq 1 ] || exit 2
case "$1" in
  python|bash|zsh) exit 0 ;;
  sql|pglab)
    # PostgreSQL 17, the version Practice's hidden tests use, from the PostgreSQL project's apt repository.
    # No default cluster: sql_runtime.py starts a private server per run from a cluster in the learner's home.
    exec 9>/var/lock/dhimantai-language.lock
    flock 9
    [ ! -x /usr/lib/postgresql/17/bin/postgres ] || exit 0
    apt-get update
    apt-get install -y --no-install-recommends postgresql-common ca-certificates curl gnupg
    mkdir -p /etc/postgresql-common/createcluster.d
    echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.d/dhimantai.conf
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
    apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17
    python -m pip install --no-cache-dir 'psycopg[binary]==3.2.3'
    exit 0 ;;
  javascript|typescript) packages="nodejs npm";;
  java) packages="openjdk-17-jdk-headless maven";;
  c) packages="gcc libc6-dev gdb make cmake pkg-config";;
  go) packages="golang-go delve";;
  rust) packages="rustc cargo gcc gdb";;
  *) exit 2 ;;
esac
# Only fixed package sets are reachable from the learner's language selection.
exec 9>/var/lock/dhimantai-language.lock
flock 9
target="/usr/local/share/jupyter/kernels/$1"
[ ! -f "$target/kernel.json" ] || exit 0
apt-get update
apt-get install -y --no-install-recommends $packages
if [ "$1" = typescript ]; then npm install -g typescript@5.9.3 @types/node@22.18.6; fi
mkdir -p "$target"
printf '{"argv":["/usr/local/bin/python","/opt/dhimantai/kernel.py","%s","-f","{connection_file}"],"display_name":"dhimantAI %s (program cells)","language":"%s"}\n' "$1" "$1" "$1" >"$target/kernel.tmp"
mv "$target/kernel.tmp" "$target/kernel.json"
