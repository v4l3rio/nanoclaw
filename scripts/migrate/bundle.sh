#!/usr/bin/env bash
# bundle.sh — create an encrypted, cross-arch snapshot of THE SECRETS + STATE
# of this NanoClaw install. The code itself is NOT bundled (it lives in git).
#
# What goes in:
#   .env, data/, groups/                              ← repo-local state
#   onecli/pgdump.sql                                 ← Postgres dump (secrets, agents, rules)
#   onecli/app-data.tar.gz                            ← master encryption key
#   onecli/env.txt                                    ← NEXTAUTH_SECRET + POSTGRES_* runtime env
#   onecli/{config.json,docker-compose.yml}           ← OneCLI client config
#   MANIFEST.json                                     ← source root, timestamp, versions
#
# Output: a single AES-256-CBC encrypted file. The passphrase is typed
# interactively; it never touches disk and never goes through Claude.
#
# Usage:  bash scripts/migrate/bundle.sh <output-path.enc>
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <output-path.enc>" >&2
  exit 64
fi
OUT="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# ---- preflight ----
[ -f data/v2.db ] || { echo "❌ data/v2.db not found — wrong directory?"; exit 1; }
command -v openssl >/dev/null || { echo "❌ openssl not on PATH"; exit 1; }
command -v docker  >/dev/null || { echo "❌ docker not on PATH";  exit 1; }

ONECLI_APP=$(docker ps --filter "name=onecli-app-1" --format '{{.Names}}' || true)
ONECLI_PG=$(docker ps --filter "name=onecli-postgres-1" --format '{{.Names}}' || true)
if [ -z "$ONECLI_APP" ] || [ -z "$ONECLI_PG" ]; then
  echo "❌ OneCLI containers (onecli-app-1, onecli-postgres-1) must be running so we can dump the vault."
  echo "   Start them with:  docker compose -f ~/.onecli/docker-compose.yml up -d"
  exit 1
fi

# warn if nanoclaw service still running (DB write inconsistency risk)
if launchctl list 2>/dev/null | grep -q com.nanoclaw; then
  echo "⚠ The nanoclaw service is still running (launchd shows com.nanoclaw)."
  echo "  Stop it first so SQLite files are flushed:"
  echo "    launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist"
  read -r -p "  Continue anyway? [y/N] " ans
  case "$ans" in [yY]*) ;; *) echo "Aborted."; exit 1;; esac
fi

# ---- stage ----
STAGE=$(mktemp -d -t nanoclaw-bundle-XXXXXX)
trap "rm -rf '$STAGE'" EXIT
mkdir -p "$STAGE/onecli"
echo "→ Staging at $STAGE"

# repo-local state
echo "  • copying .env, data/, groups/"
[ -f .env ] && cp .env "$STAGE/.env"
rsync -a --exclude='logs/' data/   "$STAGE/data/"
rsync -a --exclude='logs/' groups/ "$STAGE/groups/"

# OneCLI Postgres dump (logical, cross-arch)
echo "  • dumping OneCLI Postgres (logical)…"
docker exec "$ONECLI_PG" pg_dump -U onecli -d onecli \
  --clean --if-exists --no-owner --no-acl \
  > "$STAGE/onecli/pgdump.sql"
DUMP_BYTES=$(wc -c < "$STAGE/onecli/pgdump.sql")
echo "    → $DUMP_BYTES bytes"

# OneCLI app-data volume (contains secret-encryption-key)
echo "  • exporting onecli_app-data volume…"
docker run --rm \
  -v onecli_app-data:/src:ro \
  -v "$STAGE/onecli":/out \
  alpine sh -c 'cd /src && tar -czpf /out/app-data.tar.gz .'

# OneCLI runtime env (NEXTAUTH_SECRET + POSTGRES_*)
echo "  • capturing NEXTAUTH_SECRET and POSTGRES_* env…"
docker exec "$ONECLI_APP" env \
  | grep -E '^(NEXTAUTH_SECRET|NEXTAUTH_URL|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' \
  > "$STAGE/onecli/env.txt"

# OneCLI client config
mkdir -p "$STAGE/onecli/dotfiles"
[ -f "$HOME/.onecli/config.json" ]        && cp "$HOME/.onecli/config.json"        "$STAGE/onecli/dotfiles/"
[ -f "$HOME/.onecli/docker-compose.yml" ] && cp "$HOME/.onecli/docker-compose.yml" "$STAGE/onecli/dotfiles/"

# Manifest
cat > "$STAGE/MANIFEST.json" <<EOF
{
  "bundle_version": 2,
  "created_at":     "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_root":    "$ROOT",
  "source_uname":   "$(uname -s)/$(uname -m)",
  "onecli_secrets_count": $(docker exec "$ONECLI_PG" psql -U onecli -d onecli -tAc 'SELECT count(*) FROM secrets')
}
EOF
echo "  • manifest written"

# ---- encrypt ----
echo "→ Encrypting → $OUT"
echo "  You'll be prompted for a passphrase TWICE. Use 4+ random words."
(cd "$STAGE" && tar -cf - .) \
  | gzip -1 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out "$OUT"

SIZE=$(du -h "$OUT" | awk '{print $1}')
echo ""
echo "✅ Bundle ready: $OUT ($SIZE)"
echo ""
echo "Transfer it OUT-OF-BAND (USB / scp / never email)."
echo "On the Linux machine:"
echo "  1. git clone https://github.com/v4l3rio/nanoclaw.git ~/nanoclaw"
echo "  2. cp /media/usb/$(basename "$OUT") ~/"
echo "  3. cd ~/nanoclaw && bash scripts/migrate/restore.sh ~/$(basename "$OUT") ~/nanoclaw"
