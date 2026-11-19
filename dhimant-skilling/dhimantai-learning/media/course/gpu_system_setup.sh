set -eu
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04) ;; *) echo 'Automatic bare-machine setup supports Ubuntu 22.04 and 24.04.' >&2; exit 2;; esac
echo 'DHIMANTAI_PROGRESS Installing system prerequisites' >&2
apt-get update -q
apt-get -o DPkg::Lock::Timeout=120 install -y -q python3 python3-venv ca-certificates iproute2 iptables pciutils git build-essential curl libsndfile1 ffmpeg
if ! nvidia-smi -L >/dev/null 2>&1; then
  if [ "${DHIMANTAI_GPU_CONTAINER:-0}" = 1 ]; then
    echo 'The cloud container has no working GPU. Reconnect a compatible allocation; its host driver cannot be installed from a container.' >&2; exit 3
  fi
  if ! lspci -n -d 10de: | grep -Eq '030[02]:'; then
    echo 'No NVIDIA GPU is attached to this machine.' >&2; exit 3
  fi
  echo 'DHIMANTAI_PROGRESS Installing the Ubuntu NVIDIA compute driver' >&2
  apt-get install -y -q ubuntu-drivers-common "linux-headers-$(uname -r)"
  ubuntu-drivers install --gpgpu
  modprobe nvidia || true
  if ! nvidia-smi -L >/dev/null 2>&1; then
    echo 'The GPU driver needs a reboot before setup can continue.' >&2; exit 194
  fi
fi
