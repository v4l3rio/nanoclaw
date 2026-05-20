#!/usr/bin/env bash
# restore.sh — restore a NanoClaw bundle produced by bundle.sh (v2).
#
# Assumes the code is already on disk via `git clone`. This script restores
# secrets + state + OneCLI vault, installs deps, builds, and brings up the
# always-on systemd service.
#
# Usage:  bash scripts/migrate/restore.sh <bundle.enc> <dest-dir>
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <bundle.enc> <dest-dir>" >&2
  exit 64
fi
BUNDLE="$1"
DEST="$2"

[ -f "$BUNDLE" ] || { echo "❌ Bundle not found: $BUNDLE"; exit 1; }
[ -d "$DEST/.git" ] || { echo "❌ $DEST is not a git checkout. Run 'git clone' first."; exit 1; }
DEST="$(cd "$DEST" && pwd)"

# ---- preflight: deps ----
need=()
for cmd in openssl tar gzip rsync git docker pnpm bun node; do
  command -v "$cmd" >/dev/null || need+=("$cmd")
done
if [ ${#need[@]} -gt 0 ]; then
  cat <<EOF
❌ Missing: ${need[*]}

Install (Debian/Ubuntu):
  sudo apt update && sudo apt install -y openssl rsync git ca-certificates curl
  curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker \$USER  # then log out/in
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  npm install -g pnpm
  curl -fsSL https://bun.sh/install | bash
EOF
  exit 1
fi

# ---- decrypt ----
STAGE=$(mktemp -d -t nanoclaw-restore-XXXXXX)
trap "rm -rf '$STAGE'" EXIT
echo "→ Decrypting bundle (passphrase prompt next)…"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$BUNDLE" | gunzip | tar -xf - -C "$STAGE"

[ -f "$STAGE/MANIFEST.json" ] || { echo "❌ Bundle malformed (no MANIFEST.json)"; exit 1; }
ORIGINAL_ROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).source_root)' "$STAGE/MANIFEST.json")
SECRETS_COUNT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onecli_secrets_count)' "$STAGE/MANIFEST.json")
echo "  source root: $ORIGINAL_ROOT"
echo "  dest root:   $DEST"
echo "  OneCLI secrets in bundle: $SECRETS_COUNT"

# ---- restore repo-local state ----
echo "→ Restoring .env, data/, groups/"
[ -f "$STAGE/.env" ]   && cp "$STAGE/.env"   "$DEST/.env"
[ -d "$STAGE/data"   ] && rsync -a "$STAGE/data/"   "$DEST/data/"
[ -d "$STAGE/groups" ] && rsync -a "$STAGE/groups/" "$DEST/groups/"

# Rewrite any leftover absolute paths in text-config files
if [ -n "$ORIGINAL_ROOT" ] && [ "$ORIGINAL_ROOT" != "$DEST" ]; then
  echo "→ Rewriting paths: $ORIGINAL_ROOT → $DEST"
  find "$DEST" -type f \( -name '*.json' -o -name '*.sh' -o -name '*.md' -o -name '*.local.md' \) \
    -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/logs/*" \
    -exec grep -l "$ORIGINAL_ROOT" {} + 2>/dev/null \
    | while read -r f; do sed -i "s|$ORIGINAL_ROOT|$DEST|g" "$f"; done
fi

# ---- restore OneCLI client config ----
mkdir -p "$HOME/.onecli"
[ -f "$STAGE/onecli/dotfiles/config.json" ]        && cp "$STAGE/onecli/dotfiles/config.json"        "$HOME/.onecli/"
[ -f "$STAGE/onecli/dotfiles/docker-compose.yml" ] && cp "$STAGE/onecli/dotfiles/docker-compose.yml" "$HOME/.onecli/"

# Write OneCLI runtime env where compose expects it (~/.env, per ../.env in compose)
if [ -s "$STAGE/onecli/env.txt" ]; then
  echo "→ Writing OneCLI runtime env to ~/.env"
  # remove any prior matching entries, then append
  if [ -f "$HOME/.env" ]; then
    grep -vE '^(NEXTAUTH_SECRET|NEXTAUTH_URL|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' "$HOME/.env" > "$HOME/.env.tmp" || true
    mv "$HOME/.env.tmp" "$HOME/.env"
  fi
  cat "$STAGE/onecli/env.txt" >> "$HOME/.env"
  chmod 600 "$HOME/.env"
fi

# ---- restore OneCLI Docker volumes ----
echo "→ Restoring OneCLI volumes (pg + app-data)…"
docker volume create onecli_pgdata    >/dev/null
docker volume create onecli_app-data  >/dev/null

# Populate app-data with master key (must exist BEFORE app starts)
docker run --rm \
  -v onecli_app-data:/dst \
  -v "$STAGE/onecli":/src:ro \
  alpine sh -c 'cd /dst && tar -xzpf /src/app-data.tar.gz'

# Bring up Postgres only, restore the dump, then start the rest
( cd "$HOME/.onecli" && docker compose up -d postgres )
echo "  • waiting for postgres to accept connections…"
for i in {1..30}; do
  if docker exec onecli-postgres-1 pg_isready -U onecli >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "  • restoring pgdump.sql…"
docker exec -i onecli-postgres-1 psql -U onecli -d onecli < "$STAGE/onecli/pgdump.sql" >/dev/null
( cd "$HOME/.onecli" && docker compose up -d )

# verify
sleep 3
RESTORED=$(docker exec onecli-postgres-1 psql -U onecli -d onecli -tAc 'SELECT count(*) FROM secrets' 2>/dev/null || echo 0)
echo "  ✓ OneCLI secrets restored: $RESTORED (expected $SECRETS_COUNT)"
if [ "$RESTORED" != "$SECRETS_COUNT" ]; then
  echo "  ⚠ Mismatch — check 'docker logs onecli-app-1' if downstream calls 401."
fi

# ---- nanoclaw deps + build ----
echo "→ pnpm install (host)…"
( cd "$DEST" && pnpm install --frozen-lockfile )
echo "→ bun install (agent-runner)…"
( cd "$DEST/container/agent-runner" && bun install --frozen-lockfile )
echo "→ pnpm build…"
( cd "$DEST" && pnpm run build )

# Fix container_configs hostPath mounts (additionalMounts)
echo "→ Patching container_configs hostPath mounts…"
( cd "$DEST" && pnpm exec tsx scripts/migrate/fix-db-paths.ts "$ORIGINAL_ROOT" "$DEST" )

echo "→ Building agent container image (this may take a few minutes)…"
( cd "$DEST" && ./container/build.sh )

# ---- systemd unit + always-on hardening ----
if [ "$(uname)" = "Linux" ] && command -v systemctl >/dev/null; then
  echo "→ Installing systemd user unit…"
  mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/nanoclaw"

  cat > "$HOME/.config/systemd/user/nanoclaw.service" <<EOF
[Unit]
Description=NanoClaw host (always-on personal assistant)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DEST
ExecStart=$DEST/start.sh
Restart=always
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=10
StandardOutput=append:$DEST/logs/nanoclaw.log
StandardError=append:$DEST/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
EOF

  cat > "$HOME/.config/nanoclaw/logrotate.conf" <<EOF
$DEST/logs/*.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
EOF

  systemctl --user daemon-reload

  echo ""
  echo "→ Always-on hardening (sudo prompt next, single password)…"
  sudo -v
  sudo systemctl enable --now docker >/dev/null 2>&1 && echo "  ✓ docker enabled at boot"
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    sudo loginctl enable-linger "$USER" && echo "  ✓ user lingering enabled"
  fi
  if [ -f /etc/systemd/logind.conf ]; then
    sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/'                       /etc/systemd/logind.conf
    sudo sed -i 's/^#*HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/'           /etc/systemd/logind.conf
    sudo sed -i 's/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
    sudo systemctl restart systemd-logind 2>/dev/null && echo "  ✓ lid suspend disabled"
  fi
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 && echo "  ✓ sleep targets masked"
  if ! crontab -l 2>/dev/null | grep -q 'nanoclaw-logrotate.state'; then
    ( crontab -l 2>/dev/null; echo "15 3 * * * /usr/sbin/logrotate -s \$HOME/.cache/nanoclaw-logrotate.state \$HOME/.config/nanoclaw/logrotate.conf" ) | crontab -
    echo "  ✓ daily logrotate cron installed"
  fi
  if command -v apt-get >/dev/null; then
    sudo apt-get install -y unattended-upgrades >/dev/null 2>&1 \
      && sudo dpkg-reconfigure -f noninteractive --priority=low unattended-upgrades >/dev/null 2>&1 \
      && echo "  ✓ unattended-upgrades enabled"
  fi

  echo ""
  echo "✅ Restore complete. Start the service:"
  echo "    systemctl --user enable --now nanoclaw"
  echo "    tail -f $DEST/logs/nanoclaw.log"
else
  echo ""
  echo "✅ Restore complete (no systemd — start manually with: $DEST/start.sh)"
fi

echo ""
echo "Sanity checks:"
echo "  onecli secrets list                       # should print $SECRETS_COUNT secrets"
echo "  $DEST/bin/ncl groups list"
echo "  $DEST/bin/ncl messaging-groups list"
