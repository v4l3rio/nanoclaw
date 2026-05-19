#!/usr/bin/env bash
# bundle.sh — create an encrypted, cross-platform snapshot of this NanoClaw install
# for restoring on a different machine (typically Mac → Linux).
#
# Usage:
#   bash scripts/migrate/bundle.sh <output-path.tar.gz.enc>
#
# What's included:
#   - The full git tree (clean copy, no node_modules / .git / logs)
#   - data/v2.db + data/v2-sessions/ (host + per-session SQLite)
#   - groups/                        (per-agent-group fs: CLAUDE.local.md, skills, etc.)
#   - .env
#   - OneCLI config (~/.onecli/), if present
#
# What's NOT included:
#   - node_modules, container/agent-runner/node_modules, dist/, logs/
#   - .claude/settings.local.json (host-specific permissions)
#   - macOS-specific files (LaunchAgents plist, /opt/homebrew refs)
#
# Encryption: the tarball is encrypted with openssl AES-256-CBC using a passphrase
# you type interactively. The passphrase never gets stored on disk and never
# crosses the network (you type it again on the destination machine to decrypt).
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <output-path.tar.gz.enc>" >&2
  exit 64
fi
OUT="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# --- sanity checks
[ -f data/v2.db ] || { echo "❌ data/v2.db not found — wrong directory?"; exit 1; }
[ -f .env ] || { echo "⚠ .env missing — continuing anyway."; }
command -v openssl >/dev/null || { echo "❌ openssl not on PATH"; exit 1; }

# --- ask user to stop service so the DB is in a consistent state
echo "ℹ Before bundling, stop the host service so SQLite files are flushed."
echo "  macOS: launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist"
read -r -p "Service stopped? [y/N] " ans
case "$ans" in [yY]*) ;; *) echo "Aborted."; exit 1;; esac

# --- assemble staging dir
STAGE=$(mktemp -d -t nanoclaw-bundle-XXXXXX)
trap "rm -rf '$STAGE'" EXIT
echo "→ Staging at $STAGE"

# Mirror the repo (working tree) excluding heavy / host-specific bits.
# Use rsync if available (faster + handles symlinks); fall back to tar.
EXCLUDES=(
  --exclude=node_modules --exclude='**/node_modules'
  --exclude=dist --exclude='container/agent-runner/dist'
  --exclude=logs --exclude='**/logs/*'
  --exclude='.git'
  --exclude='.claude/settings.local.json'
  --exclude='.DS_Store'
  --exclude='*.bundle.tar.gz*'
)
mkdir -p "$STAGE/repo"
if command -v rsync >/dev/null; then
  rsync -a "${EXCLUDES[@]}" ./ "$STAGE/repo/"
else
  (cd "$ROOT" && tar -cf - "${EXCLUDES[@]}" .) | (cd "$STAGE/repo" && tar -xf -)
fi

# OneCLI config (vault + secrets are typically here on macOS+Linux)
if [ -d "$HOME/.onecli" ]; then
  mkdir -p "$STAGE/onecli"
  rsync -a "$HOME/.onecli/" "$STAGE/onecli/"
  echo "  ✓ Bundled ~/.onecli/"
else
  echo "  ⚠ No ~/.onecli/ found — you'll need to re-init OneCLI manually on the target."
fi

# Record the original repo root so restore can fix-up absolute paths
echo "$ROOT" > "$STAGE/ORIGINAL_ROOT.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$STAGE/BUNDLED_AT.txt"
uname -a > "$STAGE/SOURCE_UNAME.txt"

# --- tar + encrypt in one pipeline
echo "→ Compressing + encrypting → $OUT"
echo "  You'll be prompted for a passphrase TWICE. Remember it — you need the same one on the Linux machine."
(cd "$STAGE" && tar -cf - .) \
  | gzip -1 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out "$OUT"

SIZE=$(du -h "$OUT" | awk '{print $1}')
echo ""
echo "✅ Bundle ready: $OUT ($SIZE)"
echo ""
echo "Next steps:"
echo "  1. Transfer the .enc file to the Linux machine (scp / USB / cloud drive)."
echo "  2. On the Linux machine, in Claude Code: run /move-to-linux"
echo "     (or directly: bash scripts/migrate/restore.sh <bundle.enc> ~/nanoclaw)"
