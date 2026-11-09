#!/bin/sh
set -eu
# Extension-owned shell setup, also used when upgrading an older course Dockerfile.
if ! command -v zsh >/dev/null || ! command -v sudo >/dev/null || ! command -v git >/dev/null || ! command -v curl >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends zsh sudo git curl ca-certificates
  rm -rf /var/lib/apt/lists/*
fi
revision=cca3bdfbef8c52ef8939ce7911ff68852b949daa
if [ "$(cat /opt/oh-my-zsh/.dhimantai-revision 2>/dev/null || true)" != "$revision" ]; then
  temporary=$(mktemp -d /opt/dhimantai-zsh.XXXXXX)
  trap 'rm -rf "$temporary"' EXIT
  git -C "$temporary" init --quiet
  git -C "$temporary" fetch --quiet --depth 1 https://github.com/ohmyzsh/ohmyzsh.git "$revision"
  git -C "$temporary" checkout --quiet --detach FETCH_HEAD
  rm -rf "$temporary/.git"
  printf '%s\n' "$revision" > "$temporary/.dhimantai-revision"
  chmod -R a+rX "$temporary"
  chmod 755 "$temporary"
  rm -rf /opt/oh-my-zsh
  mv "$temporary" /opt/oh-my-zsh
fi
printf 'ALL ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/dhimantai-course
chmod 440 /etc/sudoers.d/dhimantai-course
