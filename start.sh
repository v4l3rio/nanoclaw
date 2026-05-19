#!/bin/bash
# Portable launcher — used by launchd (macOS) and systemd (Linux).
# Resolves nanoclaw root from this script's location and finds node on PATH
# with the usual fallbacks per platform.
set -e
export WEBHOOK_PORT=${WEBHOOK_PORT:-3001}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Bring brew / nvm / asdf shims into PATH for non-interactive shells.
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/*/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

NODE_BIN="${NANOCLAW_NODE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "[$(date)] FATAL: node not found on PATH" >&2
  exit 127
fi

mkdir -p "$SCRIPT_DIR/logs"
echo "[$(date)] Starting, PID=$$, ROOT=$SCRIPT_DIR, NODE=$NODE_BIN" >> "$SCRIPT_DIR/logs/start.log"
exec "$NODE_BIN" "$SCRIPT_DIR/dist/index.js"
