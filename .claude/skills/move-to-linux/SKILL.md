---
name: move-to-linux
description: Restore a NanoClaw install from a Mac bundle onto this Linux machine, end-to-end (deps, paths, container, systemd service).
---

# /move-to-linux

End-to-end restore of a NanoClaw install previously bundled with `scripts/migrate/bundle.sh` on a Mac. Runs on the **destination Linux machine**.

## When to use

The user has produced a `.tar.gz.enc` bundle on their Mac (via `bash scripts/migrate/bundle.sh`) and wants to reproduce the same state here, including DB, groups, OneCLI vault, channel configs, and the systemd service.

## Prerequisites — verify FIRST

Before doing anything, check the Linux machine has:

```bash
for c in openssl rsync git docker node pnpm bun; do
  printf '%-8s %s\n' "$c" "$(command -v $c || echo MISSING)"
done
node --version
docker --version
```

If anything is `MISSING`, tell the user *what* is missing and the right install recipe for their distro. Do **not** install anything system-wide without explicit user confirmation (`sudo` calls require asking first).

Recipes to suggest (Debian/Ubuntu):
- `sudo apt update && sudo apt install -y openssl rsync git ca-certificates curl`
- Docker: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (user must log out/in after)
- Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
- pnpm: `npm install -g pnpm`
- Bun: `curl -fsSL https://bun.sh/install | bash`

## Step 1 — locate the bundle and the destination

Ask the user:
1. Full path to the encrypted bundle (e.g. `~/Downloads/nanoclaw-bundle.enc`).
2. Where to install nanoclaw on this machine (default: `~/nanoclaw`).

Confirm both before proceeding. If the destination already exists and is non-empty, ask whether to overwrite or pick another path — **never silently overwrite**.

## Step 2 — run the restore script

The restore script handles decryption, deps, paths, container build, and systemd unit creation. The user types the passphrase interactively (Claude never sees it).

```bash
cd <DEST>   # not needed if DEST doesn't exist yet — script will mkdir
bash <bundle-dir>/scripts/migrate/restore.sh <BUNDLE_PATH> <DEST>
```

**Important**: the `restore.sh` script lives inside the bundle. You first need to extract it from the bundle, or get a copy via `git clone` of the public nanoclaw repo:

```bash
# Option A: clone trunk separately to get restore.sh
git clone https://github.com/nanocoai/nanoclaw /tmp/nanoclaw-tools
bash /tmp/nanoclaw-tools/scripts/migrate/restore.sh ~/nanoclaw-bundle.enc ~/nanoclaw
```

The script will prompt for the bundle passphrase. The user types it (it's the same one used during `bundle.sh` on the Mac).

## Step 3 — restore OneCLI binary (if not already present)

The bundle includes `~/.onecli/` (config + vault) but **not** the `onecli` binary itself, since it's platform-specific. After the restore script finishes:

```bash
command -v onecli || echo "OneCLI binary missing — install it"
```

If missing, point the user to the `/init-onecli` skill or to download the Linux release from OneCLI's distribution channel. The vault config at `~/.onecli/` was already copied — once the binary is installed it'll pick it up.

Confirm secrets came through:
```bash
onecli agents list
onecli secrets list
```

If they're empty even though `~/.onecli/config.json` was restored, the credentials file on macOS was likely encrypted with the Keychain. Tell the user: re-add the API keys via OneCLI web UI at `http://127.0.0.1:10254`. The list of *which* secrets to re-add can be derived from the per-agent CLAUDE.md files and `groups/*/container.json` mcpServers entries.

## Step 4 — start the service

```bash
systemctl --user enable --now nanoclaw
systemctl --user status nanoclaw
tail -f ~/nanoclaw/logs/nanoclaw.log    # adjust path
```

If the service crashes immediately, the first place to look is `logs/nanoclaw.error.log` for delivery / DB connection errors. Common Linux-specific gotchas:

- **Docker socket permission**: user must be in `docker` group (`groups | grep docker`) — if not, `sudo usermod -aG docker $USER` then log out/in.
- **better-sqlite3 native binding**: if you see `NODE_MODULE_VERSION` mismatch, run `(cd ~/nanoclaw && pnpm rebuild better-sqlite3)`.
- **lingering host paths**: if anything refers to `/Users/<old>`, run a final pass:
  ```bash
  grep -rn '/Users/' ~/nanoclaw --include='*.json' --include='*.sh' \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=logs
  ```

## Step 5 — always-on hardening (automatic)

`restore.sh` applies all of the following automatically (the user types the sudo password once):

- `docker.service` enabled at boot
- `loginctl enable-linger` (user services survive logout)
- `/etc/systemd/logind.conf` lid-switch settings → `ignore` (laptops don't suspend on lid close)
- `sleep.target / suspend.target / hibernate.target / hybrid-sleep.target` masked
- Daily logrotate via user crontab
- `unattended-upgrades` (Debian/Ubuntu) for security patches
- systemd unit uses `Restart=always` with a crash-loop guard (10 restarts in 5 min)

**Only thing left to the user**, since it's outside the OS:
- BIOS/UEFI: set `AC Power Recovery = Power On` so the machine reboots itself after a power outage.

## Step 6 — smoke test

Have the user send a test message on whatever channel was wired. Watch:
```bash
tail -f ~/nanoclaw/logs/nanoclaw.log ~/nanoclaw/logs/nanoclaw.error.log
```

For each agent group, the first message after a fresh install will respawn its container — expect a 10-20s delay. Subsequent messages should be sub-second to dispatch.

## What this skill does NOT do

- Doesn't install Docker, Node, pnpm, or Bun (asks the user to do it).
- Doesn't migrate API keys / OAuth tokens that were stored in macOS Keychain only — those have to be re-pasted into OneCLI web UI.
- Doesn't migrate platform-specific bot registrations (Telegram, Slack, etc. tokens come along *if* they were in `.env` or in OneCLI vault; webhook URLs may need re-registering if they hit a different public hostname).

## Recovery / rollback

The bundle is non-destructive on the source machine — re-bundling and re-restoring is always safe. If the restore goes sideways, delete the destination dir and start over:
```bash
systemctl --user stop nanoclaw 2>/dev/null
rm -rf ~/nanoclaw
```
Then re-run the restore command.
