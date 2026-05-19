#!/usr/bin/env bash
# restore.sh — restore a NanoClaw bundle produced by bundle.sh, fix host-specific
# absolute paths, install deps, build the agent container, install the systemd
# user unit, and start the service.
#
# Usage:
#   bash scripts/migrate/restore.sh <bundle.tar.gz.enc> <dest-dir>
#
# Example:
#   bash restore.sh ~/nanoclaw-bundle.enc ~/nanoclaw
#
# Idempotent: re-running on top of an existing install just refreshes things.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <bundle.tar.gz.enc> <dest-dir>" >&2
  exit 64
fi
BUNDLE="$1"
DEST="$2"

[ -f "$BUNDLE" ] || { echo "❌ Bundle not found: $BUNDLE"; exit 1; }

# --- preflight: check deps ---
need=()
for cmd in openssl tar gzip rsync git; do
  command -v "$cmd" >/dev/null || need+=("$cmd")
done
command -v docker >/dev/null || need+=("docker")
command -v node >/dev/null || need+=("node (>=20)")
command -v pnpm >/dev/null || need+=("pnpm")
command -v bun >/dev/null || need+=("bun")
if [ ${#need[@]} -gt 0 ]; then
  echo "❌ Missing tools on this machine: ${need[*]}"
  echo ""
  echo "Install them first. Quick recipes (Debian/Ubuntu):"
  echo "  sudo apt update && sudo apt install -y rsync git openssl ca-certificates curl"
  echo "  curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker \$USER"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  npm install -g pnpm"
  echo "  curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

# --- decrypt + extract ---
STAGE=$(mktemp -d -t nanoclaw-restore-XXXXXX)
trap "rm -rf '$STAGE'" EXIT
echo "→ Decrypting bundle (you'll be prompted for the passphrase)…"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$BUNDLE" | gunzip | tar -xf - -C "$STAGE"

[ -f "$STAGE/ORIGINAL_ROOT.txt" ] || { echo "❌ Bundle malformed (missing ORIGINAL_ROOT.txt)"; exit 1; }
ORIGINAL_ROOT="$(cat "$STAGE/ORIGINAL_ROOT.txt")"
echo "  Original root was: $ORIGINAL_ROOT"
echo "  Restoring to:      $DEST"

# --- copy repo into dest ---
echo "→ Copying repo tree…"
rsync -a --delete-excluded \
  --exclude='data/' --exclude='groups/' --exclude='.env' \
  "$STAGE/repo/" "$DEST/"
# Then bring data/, groups/, .env into place (separate pass: we may want to
# preserve a pre-existing data/ if user re-runs restore — but for a fresh
# migration this overwrites).
rsync -a "$STAGE/repo/data/"    "$DEST/data/"    2>/dev/null || true
rsync -a "$STAGE/repo/groups/"  "$DEST/groups/"  2>/dev/null || true
[ -f "$STAGE/repo/.env" ] && cp "$STAGE/repo/.env" "$DEST/.env"

# --- fix-up absolute paths in any file that references ORIGINAL_ROOT ---
if [ -n "$ORIGINAL_ROOT" ] && [ "$ORIGINAL_ROOT" != "$DEST" ]; then
  echo "→ Rewriting absolute paths: $ORIGINAL_ROOT → $DEST"
  # text files only; binaries (SQLite) don't store host paths
  find "$DEST" -type f \( -name '*.json' -o -name '*.sh' -o -name '*.md' -o -name '*.env' -o -name '*.ts' \) \
    -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/logs/*" \
    -exec grep -l "$ORIGINAL_ROOT" {} + 2>/dev/null \
    | while read -r f; do
      sed -i.bak "s|$ORIGINAL_ROOT|$DEST|g" "$f" && rm -f "$f.bak"
    done
fi

# --- restore OneCLI config ---
if [ -d "$STAGE/onecli" ]; then
  echo "→ Restoring ~/.onecli/"
  mkdir -p "$HOME/.onecli"
  rsync -a "$STAGE/onecli/" "$HOME/.onecli/"
  echo "  ✓ done. If OneCLI binary isn't installed yet, fetch the Linux release:"
  echo "    See: https://github.com/anthropics/onecli (or use /init-onecli skill)"
fi

# --- install deps ---
echo "→ pnpm install (host)…"
(cd "$DEST" && pnpm install --frozen-lockfile)

echo "→ bun install (agent-runner)…"
(cd "$DEST/container/agent-runner" && bun install --frozen-lockfile)

echo "→ pnpm build…"
(cd "$DEST" && pnpm run build)

# --- fix DB additionalMounts paths (container_configs in v2.db) ---
echo "→ Patching container_configs.config_json mount paths in DB…"
(cd "$DEST" && pnpm exec tsx scripts/migrate/fix-db-paths.ts "$ORIGINAL_ROOT" "$DEST")

# --- build container image ---
echo "→ Building agent container image…"
(cd "$DEST" && ./container/build.sh)

# --- install systemd user unit (Linux) ---
if [ "$(uname)" = "Linux" ] && command -v systemctl >/dev/null; then
  echo "→ Installing systemd user unit…"
  mkdir -p "$HOME/.config/systemd/user"
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
# crash-loop guard: max 10 restarts in 5 min, then stop
StartLimitIntervalSec=300
StartLimitBurst=10
# journald handles logs (rotated + size-capped); files only on demand
StandardOutput=append:$DEST/logs/nanoclaw.log
StandardError=append:$DEST/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
EOF

  # logrotate config for the nanoclaw text logs
  mkdir -p "$HOME/.config/nanoclaw"
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

  # -----------------------------------------------------------------
  # Always-on hardening — applied automatically here so this Linux box
  # behaves like an actual 24/7 personal assistant.
  # All sudo calls are batched at the top so the user types the password once.
  # -----------------------------------------------------------------
  echo ""
  echo "→ Applying always-on hardening (you'll be asked for sudo once)…"

  sudo -v   # prime sudo, single password prompt

  # 1. Docker daemon starts at boot
  if systemctl list-unit-files docker.service >/dev/null 2>&1; then
    sudo systemctl enable --now docker >/dev/null 2>&1 \
      && echo "  ✓ docker.service enabled at boot" \
      || echo "  ⚠ could not enable docker.service"
  fi

  # 2. User service survives logout
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    sudo loginctl enable-linger "$USER" \
      && echo "  ✓ user lingering enabled" \
      || echo "  ⚠ could not enable linger"
  else
    echo "  ✓ user lingering already on"
  fi

  # 3. Disable lid suspend (no-op on desktops; matters on laptops)
  if [ -f /etc/systemd/logind.conf ]; then
    sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/'           /etc/systemd/logind.conf
    sudo sed -i 's/^#*HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/' /etc/systemd/logind.conf
    sudo sed -i 's/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
    sudo systemctl restart systemd-logind 2>/dev/null \
      && echo "  ✓ lid-close suspend disabled"
  fi

  # 4. Mask system sleep targets (machine never auto-suspends)
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 \
    && echo "  ✓ system sleep masked"

  # 5. Daily log rotation via user crontab
  CRON_LINE="15 3 * * * /usr/sbin/logrotate -s \$HOME/.cache/nanoclaw-logrotate.state \$HOME/.config/nanoclaw/logrotate.conf"
  if ! crontab -l 2>/dev/null | grep -q 'nanoclaw-logrotate.state'; then
    ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
    echo "  ✓ logrotate cron installed (daily 03:15)"
  else
    echo "  ✓ logrotate cron already present"
  fi

  # 6. Unattended security updates (Debian/Ubuntu only)
  if command -v apt-get >/dev/null; then
    sudo apt-get install -y unattended-upgrades >/dev/null 2>&1 \
      && sudo dpkg-reconfigure -f noninteractive --priority=low unattended-upgrades >/dev/null 2>&1 \
      && echo "  ✓ unattended-upgrades enabled"
  fi
  echo ""
  echo "✅ Restore complete."
  echo ""
  echo "To start NanoClaw:"
  echo "  systemctl --user enable --now nanoclaw"
  echo "  systemctl --user status nanoclaw"
  echo "  tail -f $DEST/logs/nanoclaw.log"
else
  echo ""
  echo "✅ Restore complete (no systemd detected — start manually with: $DEST/start.sh)"
fi

echo ""
echo "Final sanity checks (read-only):"
echo "  $DEST/bin/ncl groups list"
echo "  $DEST/bin/ncl messaging-groups list"
echo "  onecli agents list                       # verify the agent vault has your secrets"
echo "  loginctl show-user \$USER | grep Linger   # should print Linger=yes"
echo "  systemctl is-enabled docker              # should print enabled"
