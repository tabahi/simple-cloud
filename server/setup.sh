#!/usr/bin/env bash
# simplecloud server — interactive installer & uninstaller
# Usage:
#   Install:   curl -fsSL https://raw.githubusercontent.com/tabahi/simple-cloud/refs/heads/main/server/setup.sh | bash
#   Uninstall: curl -fsSL https://raw.githubusercontent.com/tabahi/simple-cloud/refs/heads/main/server/setup.sh | bash -s -- --uninstall
#   Local:     bash setup.sh [--uninstall]

set -euo pipefail

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}==>${RESET} $*"; }
success() { echo -e "${GREEN}✔${RESET}  $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
die()     { echo -e "${RED}✘  $*${RESET}" >&2; exit 1; }
ask()     { echo -en "${BOLD}$*${RESET}"; }          # inline prompt, no newline

# ── run-from-curl mode ────────────────────────────────────────────────────────
# When piped through bash, BASH_SOURCE[0] is empty and there's no local repo.
# Download the repo, then re-exec from the local copy so node/npm can find
# the source files.
DOWNLOADED_REPO=""
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "bash" || "${BASH_SOURCE[0]}" == "/dev/stdin" ]]; then
  INSTALL_ROOT="${SIMPLECLOUD_ROOT:-/opt/scserver}"
  info "Downloading simplecloud server to $INSTALL_ROOT …"
  if command -v git &>/dev/null; then
    if [[ -d "$INSTALL_ROOT/.git" ]]; then
      git -C "$INSTALL_ROOT" pull --ff-only
    else
      mkdir -p "$(dirname "$INSTALL_ROOT")"
      git clone --depth 1 https://github.com/tabahi/simple-cloud.git "$INSTALL_ROOT" 2>/dev/null \
        || { mkdir -p "$INSTALL_ROOT"; git -C "$INSTALL_ROOT" init; git -C "$INSTALL_ROOT" pull https://github.com/tabahi/simple-cloud.git main; }
    fi
    SCRIPT_DIR="$INSTALL_ROOT/server"
  else
    # fallback: download a tarball
    TMP_TAR=$(mktemp /tmp/simplecloud-XXXXX.tar.gz)
    curl -fsSL https://github.com/tabahi/simple-cloud/archive/refs/heads/main.tar.gz -o "$TMP_TAR"
    mkdir -p "$INSTALL_ROOT"
    tar -xz --strip-components=2 -C "$INSTALL_ROOT" -f "$TMP_TAR" '*/server/'
    rm -f "$TMP_TAR"
    SCRIPT_DIR="$INSTALL_ROOT"
  fi
  DOWNLOADED_REPO="$INSTALL_ROOT"
  exec bash "$SCRIPT_DIR/setup.sh" "$@"
fi

# ── normal (local) execution path ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/config"
ENV_FILE="$SCRIPT_DIR/.env"
TOKEN_FILE="$CONFIG_DIR/token.txt"

# Read a value out of an existing .env file (used by the uninstall branch).
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# ── uninstall branch ──────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
  echo ""
  echo -e "${RED}${BOLD}simplecloud server — UNINSTALL${RESET}"
  echo ""

  # Derive values from the existing .env (best-effort)
  PM2_NAME="$(env_get SC_PM2_NAME)"; PM2_NAME="${PM2_NAME:-simplecloud-server}"
  STORAGE_DIR="$(env_get SC_STORAGE_DIR)"
  TEMP_DIR="$(env_get SC_TEMP_DIR)"
  LOG_DIR="$(env_get SC_LOG_DIR)"
  DB_DIR="$(env_get SC_DB_DIR)"
  LOCKED_ZIP="$(env_get SC_LOCKED_ZIP)"

  warn "This will:"
  echo "  1. Stop and remove the PM2 process '$PM2_NAME'"
  echo "  2. Remove the server source directory: $SCRIPT_DIR"
  [[ -n "$STORAGE_DIR" ]] && echo "  3. Optionally delete storage data: $STORAGE_DIR"
  echo ""
  ask "Continue with uninstall? [y/N] "; read -r CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

  # Stop PM2 process
  if command -v pm2 &>/dev/null; then
    pm2 stop "$PM2_NAME" 2>/dev/null || true
    pm2 delete "$PM2_NAME" 2>/dev/null || true
    pm2 save --force 2>/dev/null || true
    success "PM2 process '$PM2_NAME' removed"
  else
    warn "pm2 not found — skipping PM2 removal"
  fi

  # Optionally delete data dirs
  if [[ -n "$STORAGE_DIR" ]]; then
    ask "Delete all synced files in $STORAGE_DIR? [y/N] "; read -r DEL_DATA
    if [[ "$DEL_DATA" =~ ^[Yy]$ ]]; then
      rm -rf "$STORAGE_DIR" "$TEMP_DIR" "$DB_DIR" "$LOG_DIR"
      [[ -n "$LOCKED_ZIP" ]] && rm -f "$LOCKED_ZIP"
      success "Data directories removed"
    else
      info "Data directories kept — you can delete them manually"
    fi
  fi

  # Remove server source (only if it's a downloaded copy, i.e. parent is /opt/scserver)
  PARENT_DIR="$(dirname "$SCRIPT_DIR")"
  ask "Remove server source files at $SCRIPT_DIR? [y/N] "; read -r DEL_SRC
  if [[ "$DEL_SRC" =~ ^[Yy]$ ]]; then
    rm -rf "$SCRIPT_DIR"
    # Remove parent install dir too if now empty
    [[ -d "$PARENT_DIR" ]] && rmdir --ignore-fail-on-non-empty "$PARENT_DIR" 2>/dev/null || true
    success "Server source removed"
  fi

  echo ""
  success "Uninstall complete."
  exit 0
fi

# ── install / upgrade ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}        simplecloud server — setup wizard         ${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ── prerequisites check ───────────────────────────────────────────────────────
info "Checking prerequisites…"
command -v node &>/dev/null || die "Node.js is not installed. Install Node.js 20 LTS first: https://nodejs.org/"
command -v npm  &>/dev/null || die "npm is not installed."
NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
info "Node.js $NODE_VER found"

# p7zip-full provides the `7z` binary used by the secure locked-folder feature.
if command -v 7z &>/dev/null || command -v 7za &>/dev/null; then
  info "7z found"
elif command -v apt-get &>/dev/null; then
  info "Installing p7zip-full (for the secure locked-folder feature)…"
  apt-get update -qq && apt-get install -y -qq p7zip-full \
    && success "p7zip-full installed" \
    || warn "Could not install p7zip-full automatically — the lock feature needs it. Install manually: apt install p7zip-full"
else
  warn "7z not found and apt-get unavailable. Install p7zip-full manually for the secure locked-folder feature."
fi

# ── port ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 1/5 ] Server port${RESET}"
echo "  Fastify listens on localhost; nginx (or another reverse proxy) forwards"
echo "  traffic to this port. The port is NOT opened publicly."
ask "  Port [default: 11277]: "; read -r INPUT_PORT
PORT="${INPUT_PORT:-11277}"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -gt 0 && "$PORT" -lt 65536 ]] || die "Invalid port: $PORT"
success "Using port $PORT"

# ── storage dir ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 2/5 ] Storage directory${RESET}"
echo "  Where uploaded file blobs will be stored."
ask "  Storage directory [default: /var/simplecloud/storage]: "; read -r INPUT_STORAGE
STORAGE_DIR="${INPUT_STORAGE:-/var/simplecloud/storage}"
success "Storage: $STORAGE_DIR"

TEMP_DIR="$(dirname "$STORAGE_DIR")/temp"
LOG_DIR="/var/simplecloud/logs"
DB_DIR="/var/simplecloud"
FILECHANGE_LOGS="$LOG_DIR/changes.log"
PM2_NAME="simplecloud-server"
BACKUP_DAYS=90
BACKUP_MAX_BYTES=10485760
# Secure locked-folder feature: the encrypted archive lives next to storage.
LOCKED_FOLDER_NAME=".simplecloud_locked"
LOCKED_ZIP="$(dirname "$STORAGE_DIR")/locked.7z"

# ── SSL ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 3/5 ] SSL / TLS${RESET}"
echo "  Fastify listens on localhost only. Your reverse proxy (nginx/Caddy) should"
echo "  terminate SSL — keep Fastify SSL disabled and let the proxy handle TLS."
echo "  Answer 'n' only if Fastify is exposed directly and must handle TLS itself."
ask "  Keep SSL disabled in Fastify? (recommended) [Y/n]: "; read -r INPUT_SSL
SSL_ENABLED=false
SSL_CERT=""
SSL_KEY=""

if [[ "${INPUT_SSL:-y}" =~ ^[Nn]$ ]]; then
  SSL_ENABLED=true

  # Auto-detect certs under /etc/letsencrypt/live/
  DETECTED_DOMAINS=()
  if [[ -d /etc/letsencrypt/live ]]; then
    while IFS= read -r -d '' d; do
      [[ -f "$d/fullchain.pem" && -f "$d/privkey.pem" ]] && DETECTED_DOMAINS+=("$(basename "$d")")
    done < <(find /etc/letsencrypt/live -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
  fi

  if [[ ${#DETECTED_DOMAINS[@]} -gt 0 ]]; then
    echo ""
    echo "  Detected Let's Encrypt certificate(s):"
    for i in "${!DETECTED_DOMAINS[@]}"; do
      echo "    $((i+1))) ${DETECTED_DOMAINS[$i]}"
    done
    echo "    $((${#DETECTED_DOMAINS[@]}+1))) Enter custom paths"
    echo ""
    ask "  Choose a certificate [1]: "; read -r CERT_CHOICE
    CERT_CHOICE="${CERT_CHOICE:-1}"

    if [[ "$CERT_CHOICE" =~ ^[0-9]+$ && "$CERT_CHOICE" -le "${#DETECTED_DOMAINS[@]}" ]]; then
      CHOSEN="${DETECTED_DOMAINS[$((CERT_CHOICE-1))]}"
      SSL_CERT="/etc/letsencrypt/live/$CHOSEN/fullchain.pem"
      SSL_KEY="/etc/letsencrypt/live/$CHOSEN/privkey.pem"
      success "Using cert for: $CHOSEN"
    else
      ask "  Full path to cert file (fullchain.pem): "; read -r SSL_CERT
      ask "  Full path to key file  (privkey.pem):   "; read -r SSL_KEY
    fi
  else
    warn "No Let's Encrypt certificates found under /etc/letsencrypt/live/"
    ask "  Full path to cert file (fullchain.pem): "; read -r SSL_CERT
    ask "  Full path to key file  (privkey.pem):   "; read -r SSL_KEY
  fi

  [[ -f "$SSL_CERT" ]] || die "Certificate file not found: $SSL_CERT"
  [[ -f "$SSL_KEY"  ]] || die "Key file not found: $SSL_KEY"
  success "SSL enabled with cert: $SSL_CERT"
else
  success "SSL disabled — nginx/proxy handles TLS"
fi

# ── PM2 name ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 4/6 ] PM2 process name${RESET}"
ask "  PM2 name [default: simplecloud-server]: "; read -r INPUT_PM2
PM2_NAME="${INPUT_PM2:-simplecloud-server}"
success "PM2 name: $PM2_NAME"

# ── Discord bot ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 5/7 ] Discord bot (optional)${RESET}"
echo "  Lets you browse storage and store files from Discord."
echo "  You can also configure this later by editing server/.env."
DISCORD_ENABLED=false
DISCORD_TOKEN=""
DISCORD_CLIENT_ID=""
DISCORD_GUILD_ID=""
DISCORD_USER_IDS=""
DISCORD_CHANNEL_IDS=""
ask "  Enable the Discord bot now? [y/N]: "; read -r INPUT_DISCORD
if [[ "${INPUT_DISCORD:-n}" =~ ^[Yy]$ ]]; then
  DISCORD_ENABLED=true
  echo "  Create a bot at https://discord.com/developers/applications"
  echo "  (enable the Message Content intent, invite with bot + applications.commands scopes)."
  ask "  Bot token: ";                 read -r DISCORD_TOKEN
  ask "  Application (Client) ID: ";   read -r DISCORD_CLIENT_ID
  ask "  Server (Guild) ID: ";         read -r DISCORD_GUILD_ID
  ask "  Allowed user IDs (comma-separated): ";    read -r RAW_USER_IDS
  ask "  Allowed channel IDs (comma-separated): "; read -r RAW_CHANNEL_IDS
  # Normalize "a,b , c" → "a,b,c" (trim spaces, drop empties) for the .env list.
  DISCORD_USER_IDS=$(echo "$RAW_USER_IDS"       | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | paste -sd, -)
  DISCORD_CHANNEL_IDS=$(echo "$RAW_CHANNEL_IDS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | paste -sd, -)
  success "Discord bot will be enabled"
else
  success "Discord bot disabled (enable later in server/.env)"
fi

# ── Web UI ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 6/7 ] Web UI (optional)${RESET}"
echo "  A browser UI for full management. Login is a password + an authenticator"
echo "  (TOTP) code. 2FA is strongly recommended and ON by default."
WEB_ENABLED=false
WEB_ENV_LINES=""        # extra SC_WEB_* lines appended to .env
WEB_OTPAUTH=""          # otpauth:// URL to show the user at the end
ask "  Enable the web UI now? [y/N]: "; read -r INPUT_WEB
if [[ "${INPUT_WEB:-n}" =~ ^[Yy]$ ]]; then
  WEB_ENABLED=true

  # Password (read silently, twice).
  WEB_PASS=""; WEB_PASS2="x"
  while [[ "$WEB_PASS" != "$WEB_PASS2" || -z "$WEB_PASS" ]]; do
    ask "  Web password (min 12 chars recommended): "; read -rs WEB_PASS; echo ""
    ask "  Confirm password: ";                        read -rs WEB_PASS2; echo ""
    [[ "$WEB_PASS" != "$WEB_PASS2" ]] && warn "Passwords don't match — try again."
    [[ -z "$WEB_PASS" ]] && warn "Password cannot be empty."
  done

  # 2FA (default yes).
  ask "  Enable TOTP 2FA (strongly recommended)? [Y/n]: "; read -r INPUT_TOTP
  TOTP_FLAG=""
  if [[ "${INPUT_TOTP:-y}" =~ ^[Nn]$ ]]; then
    warn "2FA disabled — a single password will protect full access. NOT recommended for a public deployment."
    TOTP_FLAG="--no-totp"
  else
    # Install qrencode now so the QR is scannable at the end of setup.
    if ! command -v qrencode &>/dev/null && command -v apt-get &>/dev/null; then
      apt-get install -y -qq qrencode 2>/dev/null \
        && success "qrencode installed" \
        || true
    fi
  fi

  # Generate hash + secrets via the Node helper (no shell history exposure).
  WEB_OUT=$(printf '%s' "$WEB_PASS" | node "$SCRIPT_DIR/src/web/setupWeb.js" $TOTP_FLAG)
  WEB_PASS=""; WEB_PASS2=""   # scrub from shell memory
  # Split off the #OTPAUTH comment line (shown to the user) from the env lines.
  WEB_OTPAUTH=$(echo "$WEB_OUT" | sed -n 's/^#OTPAUTH //p')
  WEB_ENV_LINES=$(echo "$WEB_OUT" | grep -v '^#OTPAUTH')
  success "Web UI will be enabled"
else
  success "Web UI disabled (enable later with: re-run setup.sh)"
fi

# ── confirm ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[ 7/7 ] Confirm settings${RESET}"
echo ""
echo "  Port:        $PORT"
echo "  Storage:     $STORAGE_DIR"
echo "  Temp:        $TEMP_DIR"
echo "  Logs:        $LOG_DIR"
echo "  Database:    $DB_DIR"
echo "  SSL:         $SSL_ENABLED"
[[ "$SSL_ENABLED" == "true" ]] && echo "  Cert:        $SSL_CERT"
echo "  PM2 name:    $PM2_NAME"
echo "  Discord bot: $DISCORD_ENABLED"
echo "  Web UI:      $WEB_ENABLED"
echo ""
ask "  Proceed with installation? [Y/n]: "; read -r PROCEED
[[ "${PROCEED:-y}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── write .env ────────────────────────────────────────────────────────────────
# Back up any existing .env so a re-run never silently clobbers custom edits.
if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  info "Existing .env backed up"
fi

cat > "$ENV_FILE" <<EOF
# simplecloud server configuration — generated by setup.sh.
# This file is gitignored. Edit it and run: pm2 restart $PM2_NAME

SC_PORT=$PORT
SC_HOST=127.0.0.1

SC_STORAGE_DIR=$STORAGE_DIR
SC_TEMP_DIR=$TEMP_DIR
SC_LOG_DIR=$LOG_DIR
SC_DB_DIR=$DB_DIR
SC_FILECHANGE_LOGS=$FILECHANGE_LOGS

SC_PM2_NAME=$PM2_NAME
SC_BACKUP_RETENTION_DAYS=$BACKUP_DAYS
SC_BACKUP_MAX_FILE_SIZE_BYTES=$BACKUP_MAX_BYTES

SC_LOCKED_FOLDER_NAME=$LOCKED_FOLDER_NAME
SC_LOCKED_ZIP=$LOCKED_ZIP

SC_SSL_ENABLED=$SSL_ENABLED
SC_SSL_CERT_FILE=$SSL_CERT
SC_SSL_KEY_FILE=$SSL_KEY

SC_DISCORD_ENABLED=$DISCORD_ENABLED
SC_DISCORD_TOKEN=$DISCORD_TOKEN
SC_DISCORD_CLIENT_ID=$DISCORD_CLIENT_ID
SC_DISCORD_GUILD_ID=$DISCORD_GUILD_ID
SC_DISCORD_ALLOWED_USER_IDS=$DISCORD_USER_IDS
SC_DISCORD_ALLOWED_CHANNEL_IDS=$DISCORD_CHANNEL_IDS
SC_DISCORD_MAX_UPLOAD_BYTES=26214400

SC_WEB_ENABLED=$WEB_ENABLED
SC_WEB_SESSION_TTL_MINUTES=60
EOF

# Append the generated web secrets (password hash, session secret, TOTP secret)
# when the web UI is enabled.
if [[ "$WEB_ENABLED" == "true" && -n "$WEB_ENV_LINES" ]]; then
  printf '%s\n' "$WEB_ENV_LINES" >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"
success "Wrote $ENV_FILE"

# ── create directories ─────────────────────────────────────────────────────────
info "Creating directories…"
mkdir -p "$STORAGE_DIR" "$TEMP_DIR" "$LOG_DIR" "$DB_DIR"

NODE_USER="${SUDO_USER:-$(whoami)}"
for DIR in "$STORAGE_DIR" "$TEMP_DIR" "$LOG_DIR" "$DB_DIR"; do
  chown -R "$NODE_USER":"$NODE_USER" "$DIR" 2>/dev/null || true
  chmod 750 "$DIR"
done
success "Directories ready"

# ── npm install ───────────────────────────────────────────────────────────────
# NOTE: do NOT pass --omit=dev here. With a committed package-lock.json, npm
# installs from the lockfile; if the lock predates a newly added dependency
# (e.g. discord.js) it would be silently skipped. A plain `npm install`
# reconciles package.json with the lockfile and pulls in anything missing.
# There are no devDependencies, so --omit=dev buys nothing anyway.
info "Installing npm dependencies…"
cd "$SCRIPT_DIR"
npm install
success "Dependencies installed"

# ── auth token ────────────────────────────────────────────────────────────────
info "Auth token…"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$TOKEN_FILE" ]; then
  node -e "const c=require('crypto');require('fs').writeFileSync('$TOKEN_FILE',c.randomBytes(32).toString('hex'));"
  success "Token generated at $TOKEN_FILE"
else
  success "Token already exists — keeping existing token"
fi

# ── PM2 ───────────────────────────────────────────────────────────────────────
info "Setting up PM2…"
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2 globally…"
  npm install -g pm2 --silent
fi

pm2 stop "$PM2_NAME" 2>/dev/null || true
pm2 delete "$PM2_NAME" 2>/dev/null || true
pm2 start "$SCRIPT_DIR/src/index.js" \
  --name "$PM2_NAME" \
  --interpreter node
pm2 save
pm2 startup 2>/dev/null | tail -1 || true
success "Server started under PM2 as '$PM2_NAME'"

# ── health check ──────────────────────────────────────────────────────────────
sleep 1
info "Verifying server health…"
HEALTH=$(curl -s "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  success "Health check passed: $HEALTH"
else
  warn "Health check did not return ok (server may still be starting): $HEALTH"
fi

# ── print token & next steps ─────────────────────────────────────────────────
TOKEN=$(cat "$TOKEN_FILE")

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${GREEN}  ✔  simplecloud server is running!              ${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Your auth token:${RESET}"
echo ""
echo -e "  ${YELLOW}${BOLD}$TOKEN${RESET}"
echo ""
echo "  Copy this token — you'll need it when setting up each client."
echo ""
if [[ "$WEB_ENABLED" == "true" ]]; then
  echo -e "  ${BOLD}Web UI is enabled.${RESET} Open it in a browser at your server's public URL."
  if [[ -n "$WEB_OTPAUTH" ]]; then
    echo ""
    echo -e "  ${YELLOW}${BOLD}>>> SCAN THIS INTO YOUR AUTHENTICATOR APP NOW <<<${RESET}"
    echo -e "  (it is shown only once and is not stored in plaintext)"
    echo ""
    echo -e "  ${BOLD}$WEB_OTPAUTH${RESET}"
    # Render a scannable QR in the terminal if qrencode is available.
    if command -v qrencode &>/dev/null; then
      echo ""
      qrencode -m 2 -t utf8 "$WEB_OTPAUTH"
    else
      echo ""
      echo "  (install 'qrencode' to display a scannable QR here, or paste the"
      echo "   otpauth:// URL into your authenticator app manually.)"
    fi
    echo ""
  fi
fi
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo "  1. Make sure your reverse proxy (nginx/Caddy) forwards external"
echo "     traffic to http://127.0.0.1:$PORT"
echo ""
echo "  2. On each client machine, install the client and paste the token"
echo "     into the config file:"
echo ""
echo "       Windows:  %APPDATA%\\simplecloud\\config.json"
echo "       Linux:    ~/.config/simplecloud/config.json"
echo ""
echo "  3. Useful server commands:"
echo "       pm2 logs $PM2_NAME          # live log tail"
echo "       pm2 restart $PM2_NAME       # restart after changes"
echo "       pm2 stop $PM2_NAME          # stop the server"
echo ""
echo "  4. To get the token again later:"
echo "       cat $TOKEN_FILE"
echo ""
if [[ "$DISCORD_ENABLED" == "true" ]]; then
  echo "  5. Discord bot is enabled. Slash commands (/list, /tree, /search,"
  echo "     /get) are registered; drop an attachment in an allowed channel to"
  echo "     store it under discord_files/. Check 'pm2 logs $PM2_NAME' to confirm login."
  echo ""
  echo "  6. To uninstall:"
else
  echo "  5. Optional: enable the Discord bot by editing the SC_DISCORD_* vars in"
  echo "     $ENV_FILE, then run: pm2 restart $PM2_NAME"
  echo ""
  echo "  6. To uninstall:"
fi
echo "       bash $SCRIPT_DIR/setup.sh --uninstall"
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
