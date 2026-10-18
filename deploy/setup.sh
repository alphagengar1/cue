#!/usr/bin/env bash
# Cue backend: idempotent server bootstrap for Ubuntu 24.04 (AWS Lightsail or EC2).
#
#   sudo ./setup.sh                 # hostname = <public ip>.sslip.io
#   sudo HOST=api.cue.example ./setup.sh
#   sudo REPO_URL=https://github.com/you/cue.git BRANCH=main ./setup.sh
#
# Does, in order: Node 22, Caddy, clone/pull the repo to /opt/cue, npm ci, Caddyfile,
# systemd unit, enable + (re)start both services. Safe to rerun at any time: rerun it
# after copying backend/.env, and rerun it to redeploy after a git push.
#
# Never prints values from backend/.env.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/alphagengar1/cue.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/cue}"
RUN_USER="${RUN_USER:-${SUDO_USER:-ubuntu}}"
HOST="${HOST:-${1:-}}"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
[[ "$RUN_USER" != "root" ]] || RUN_USER=ubuntu
id "$RUN_USER" >/dev/null 2>&1 || die "user $RUN_USER does not exist (set RUN_USER=...)"

if [[ -z "$HOST" ]]; then
  IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not detect public IP; pass HOST=..."
  HOST="${IP}.sslip.io"
fi
log "hostname: $HOST   repo: $REPO_URL ($BRANCH)   dir: $APP_DIR   user: $RUN_USER"

export DEBIAN_FRONTEND=noninteractive

# --- base packages -----------------------------------------------------------
log "apt packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

# --- swap (the $7 Lightsail box has 1 GB RAM; tsx + SDKs are comfortable with a little headroom)
if ! swapon --show | grep -q '^/swapfile'; then
  log "1 GB swapfile"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Node 22 (NodeSource) ----------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  log "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "node $(node -v), npm $(npm -v)"

# --- Caddy (official apt repo) ----------------------------------------------
if ! command -v caddy >/dev/null; then
  log "Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# --- code ----------------------------------------------------------------------
if [[ -d "$APP_DIR/.git" ]]; then
  log "git pull ($BRANCH)"
  sudo -u "$RUN_USER" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u "$RUN_USER" git -C "$APP_DIR" checkout --quiet "$BRANCH"
  sudo -u "$RUN_USER" git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
elif [[ -d "$APP_DIR/backend" ]]; then
  log "$APP_DIR exists without .git (rsync deploy); leaving files as they are"
else
  log "git clone"
  mkdir -p "$APP_DIR" && chown "$RUN_USER:$RUN_USER" "$APP_DIR"
  sudo -u "$RUN_USER" git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
[[ -f "$APP_DIR/backend/package.json" ]] || die "no backend/package.json in $APP_DIR"

log "npm ci (backend)"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR/backend' && npm ci --no-audit --no-fund --loglevel=error"
[[ -x "$APP_DIR/backend/node_modules/.bin/tsx" ]] || die "tsx missing after npm ci"

# --- backend/.env ----------------------------------------------------------------
ENV_FILE="$APP_DIR/backend/.env"
PORT=8787
HAVE_ENV=0
if [[ -f "$ENV_FILE" ]]; then
  HAVE_ENV=1
  chown "$RUN_USER:$RUN_USER" "$ENV_FILE" && chmod 600 "$ENV_FILE"
  p="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  [[ "$p" =~ ^[0-9]+$ ]] && PORT="$p"
  # Point the CREAO webhook at this host unless a base URL is already set.
  if grep -qE '^PUBLIC_BASE_URL=\s*$' "$ENV_FILE"; then
    sed -i -E "s|^PUBLIC_BASE_URL=\s*$|PUBLIC_BASE_URL=https://$HOST|" "$ENV_FILE"
    log "set PUBLIC_BASE_URL=https://$HOST in backend/.env"
  elif ! grep -qE '^PUBLIC_BASE_URL=' "$ENV_FILE"; then
    printf '\nPUBLIC_BASE_URL=https://%s\n' "$HOST" >> "$ENV_FILE"
    log "added PUBLIC_BASE_URL=https://$HOST to backend/.env"
  fi
  tok="$(grep -E '^DEVICE_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  if [[ -z "$tok" || "$tok" == "change-me" ]]; then
    warn "DEVICE_TOKEN is empty or still 'change-me': /api/* would be open to the internet. Set it, then rerun."
  fi
  grep -qE '^OPENAI_API_KEY=.+' "$ENV_FILE" || warn "OPENAI_API_KEY not set: decision gate is off"
  if ! grep -qE '^(PHOTON|SPECTRUM)_PROJECT_ID=.+' "$ENV_FILE"; then warn "Photon keys not set: iMessage recap is off"; fi
else
  warn "no $ENV_FILE yet. From your laptop:  scp backend/.env $RUN_USER@$HOST:$APP_DIR/backend/.env   then rerun this script."
fi

# --- Caddy config --------------------------------------------------------------------
log "Caddyfile for $HOST -> 127.0.0.1:$PORT"
sed -e "s/__HOST__/$HOST/g" -e "s/__PORT__/$PORT/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable --now caddy >/dev/null
systemctl reload caddy

# --- systemd unit --------------------------------------------------------------------
log "systemd unit cue-backend"
sed -e "s|^User=.*|User=$RUN_USER|" \
    -e "s|/opt/cue|$APP_DIR|g" \
    "$APP_DIR/deploy/cue-backend.service" > /etc/systemd/system/cue-backend.service
systemctl daemon-reload
systemctl enable cue-backend >/dev/null
if [[ $HAVE_ENV -eq 1 ]]; then
  systemctl restart cue-backend
  sleep 2
  if systemctl is-active --quiet cue-backend; then
    log "cue-backend is running"
  else
    systemctl status cue-backend --no-pager -l | tail -20
    die "cue-backend failed to start (journalctl -u cue-backend -n 50)"
  fi
else
  systemctl stop cue-backend 2>/dev/null || true
  warn "cue-backend not started: waiting for backend/.env"
fi

cat <<MSG

Done.
  URL:      https://$HOST
  Logs:     journalctl -u cue-backend -f        (Caddy: journalctl -u caddy -f)
  Check:    from your laptop   deploy/check.sh $HOST
  Redeploy: git push, then    sudo $APP_DIR/deploy/setup.sh
MSG
