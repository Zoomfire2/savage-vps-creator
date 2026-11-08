#!/bin/bash
set -e
# Env provided by the bot: VPS_HOSTNAME, VPS_ROOT_PASSWORD_HASH (SHA-512 crypt), SSH_AUTHORIZED_KEY, VPS_DATA_DIR
if [ -z "$VPS_ROOT_PASSWORD_HASH" ] && [ -z "$SSH_AUTHORIZED_KEY" ]; then
  echo "No credentials supplied; refusing to start sshd." >&2; exit 1
fi
[ -n "$VPS_HOSTNAME" ] && echo "$VPS_HOSTNAME" > /etc/hostname && hostname "$VPS_HOSTNAME" 2>/dev/null || true
[ -n "$VPS_ROOT_PASSWORD_HASH" ] && usermod -p "$VPS_ROOT_PASSWORD_HASH" root
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -n "$SSH_AUTHORIZED_KEY" ] && echo "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
# Do not leave credentials in the environment of login shells
unset VPS_ROOT_PASSWORD_HASH
cat > /etc/ssh/sshd_config.d/savage.conf <<CONF
PermitRootLogin yes
PasswordAuthentication yes
PubkeyAuthentication yes
MaxAuthTries 4
LoginGraceTime 30
ClientAliveInterval 60
CONF
ssh-keygen -A
chmod 755 "${VPS_DATA_DIR:-/data}" 2>/dev/null || true
exec /usr/sbin/sshd -D -e
