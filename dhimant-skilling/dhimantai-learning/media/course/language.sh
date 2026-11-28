#!/bin/sh
set -eu
[ "$#" -eq 1 ] || exit 2
case "$1" in
  python|bash|zsh) exit 0 ;;
  redis)
    exec 9>/var/lock/dhimantai-language.lock
    flock 9
    if ! command -v redis-server >/dev/null; then
      apt-get update
      apt-get install -y --no-install-recommends redis-server redis-tools
    fi
    redis-server --version >/dev/null
    redis-cli --version >/dev/null
    exit 0 ;;
  audio)
    # CPU dataset preparation in the STT and TTS courses uses the ffmpeg executable.
    exec 9>/var/lock/dhimantai-language.lock
    flock 9
    if ! command -v ffmpeg >/dev/null; then
      apt-get update
      apt-get install -y --no-install-recommends ffmpeg
    fi
    ffmpeg -version >/dev/null
    exit 0 ;;
  sql|pglab|postgres)
    # PostgreSQL 17 (also the "postgres" service, e.g. for the Ask your data lab in a non-SQL course), the version Practice's hidden tests use, from the PostgreSQL project's apt repository.
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
  javascript|typescript) packages="";;
  java) packages="openjdk-17-jdk-headless maven";;
  cpp) packages="g++ libc6-dev gdb make cmake pkg-config";;
  c) packages="gcc libc6-dev gdb make cmake pkg-config";;
  go) packages="golang-go delve yaegi rlwrap";;
  rust) packages="gcc libc6-dev gdb curl unzip zstd ca-certificates";;
  *) exit 2 ;;
esac
# Only fixed package sets are reachable from the learner's language selection.
exec 9>/var/lock/dhimantai-language.lock
flock 9
target="/usr/local/share/jupyter/kernels/$1"
architecture=$(dpkg --print-architecture)
if [ -f "$target/kernel.json" ]; then
  case "$1:$architecture" in
    rust:amd64|rust:arm64) if command -v evcxr >/dev/null; then exit 0; fi ;;
    go:*) if command -v yaegi >/dev/null; then exit 0; fi ;;
    *) exit 0 ;;
  esac
fi
case "$1:$architecture" in
  rust:amd64|rust:arm64) install_evcxr=true ;;
  rust:*) install_evcxr=false; packages="rustc cargo gcc libc6-dev gdb" ;;
  *) install_evcxr=false ;;
esac
if [ -n "$packages" ]; then
  apt-get update
  apt-get install -y --no-install-recommends $packages
fi
if [ "$install_evcxr" = true ]; then
  # Evcxr loads the Rust shared standard library. Debian's rustc may ship only the static library.
  case "$architecture" in
    amd64) triple=x86_64-unknown-linux-gnu; archive=linux-64/evcxr-0.21.1-hb17b654_0.conda
      rustup_sha=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
      repl_sha=1ea0cf3af965634894f46eb23868394344db8ea079df70e3163410bf2a083829 ;;
    arm64) triple=aarch64-unknown-linux-gnu; archive=linux-aarch64/evcxr-0.21.1-h069e38c_0.conda
      rustup_sha=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c
      repl_sha=91ec9c1a037e2c82e872c1bb5afc025c130ad4ae5691fc5d137b4e8901feeb3e ;;
  esac
  temp=$(mktemp -d)
  trap 'rm -rf "$temp"' EXIT
  curl -fsSL --retry 2 "https://static.rust-lang.org/rustup/archive/1.28.2/$triple/rustup-init" -o "$temp/rustup-init"
  echo "$rustup_sha  $temp/rustup-init" | sha256sum -c -
  chmod 755 "$temp/rustup-init"
  export RUSTUP_HOME=/opt/course-rustup CARGO_HOME=/opt/course-cargo
  "$temp/rustup-init" -y --profile minimal --no-modify-path --default-toolchain 1.91.1 --component rust-src
  toolchain=$("$CARGO_HOME/bin/rustc" --print sysroot)
  for tool in cargo rustc rustdoc; do ln -sf "$toolchain/bin/$tool" "/usr/local/bin/$tool"; done
  curl -fsSL --retry 2 "https://conda.anaconda.org/conda-forge/$archive" -o "$temp/evcxr.conda"
  echo "$repl_sha  $temp/evcxr.conda" | sha256sum -c -
  unzip -q "$temp/evcxr.conda" -d "$temp"
  tar -xOf "$temp"/pkg-*.tar.zst bin/evcxr > "$temp/evcxr"
  install -m 755 "$temp/evcxr" /usr/local/bin/evcxr
  mkdir -p /usr/local/share/doc/evcxr
  tar -xf "$temp"/info-*.tar.zst -C /usr/local/share/doc/evcxr --strip-components=2 info/licenses
fi
if [ "$1" = javascript ] || [ "$1" = typescript ]; then node --version; npm --version; fi
if [ "$1" = typescript ]; then npm install -g typescript@5.9.3 @types/node@22.18.6; fi
mkdir -p "$target"
printf '{"argv":["/usr/local/bin/python","/opt/dhimantai/kernel.py","%s","-f","{connection_file}"],"display_name":"dhimantAI %s (program cells)","language":"%s"}\n' "$1" "$1" "$1" >"$target/kernel.tmp"
mv "$target/kernel.tmp" "$target/kernel.json"
