---
name: move-to-linux
description: Restore a NanoClaw install on this Linux machine from a Mac-produced encrypted bundle. Two channels — code via git clone, secrets+state via the bundle. Configures always-on systemd.
---

# /move-to-linux

End-to-end restore on the **destination Linux machine**. Two transfer channels:

- **Code** → `git clone https://github.com/v4l3rio/nanoclaw.git` (public, no secrets)
- **Secrets + state** → encrypted bundle file produced on the Mac by `scripts/migrate/bundle.sh` (`.env`, `data/`, `groups/`, full OneCLI vault dump + master key + NEXTAUTH_SECRET)

## Step 1 — preflight

Verify required tools:

```bash
for c in openssl rsync git docker node pnpm bun; do
  printf '%-8s %s\n' "$c" "$(command -v $c || echo MISSING)"
done
node --version    # need >= 20
docker --version
```

If anything is `MISSING`, tell the user which command to install — do not install system-wide things without explicit consent.

Quick recipes (Debian/Ubuntu):
- `sudo apt update && sudo apt install -y openssl rsync git ca-certificates curl`
- `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (re-login after)
- `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
- `npm install -g pnpm`
- `curl -fsSL https://bun.sh/install | bash`

## Step 2 — clone the repo

```bash
git clone https://github.com/v4l3rio/nanoclaw.git ~/nanoclaw
```

Default dest is `~/nanoclaw` but the user can choose anywhere.

## Step 3 — transfer the bundle

The bundle is the `.enc` file the user produced on the Mac. Options:

- **USB**: plug in, `cp /media/<user>/<usb>/nanoclaw-bundle.enc ~/` — cleanest, air-gapped.
- **scp**: `scp user@mac:~/nanoclaw-bundle.enc ~/` — needs SSH on either side.
- **AirDrop, Drive, Dropbox**: the file is already AES-256 encrypted, so it's safe in transit, but USB is still preferred for one-shot.

## Step 4 — run the restore

```bash
cd ~/nanoclaw
bash scripts/migrate/restore.sh ~/nanoclaw-bundle.enc ~/nanoclaw
```

The script will:
1. Prompt for the bundle passphrase (same one used on the Mac).
2. Restore `.env`, `data/`, `groups/` into the cloned repo.
3. Rewrite any absolute path that referenced the Mac install root.
4. **Restore the OneCLI vault**:
   - create Docker volumes `onecli_pgdata` + `onecli_app-data`
   - extract the master key into `app-data`
   - `docker compose up postgres`
   - `psql … < pgdump.sql` → restore secrets table
   - write `NEXTAUTH_SECRET` + `POSTGRES_*` to `~/.env`
   - `docker compose up -d` (full OneCLI stack)
5. `pnpm install` + `bun install` + build host + build agent container image.
6. Patch `container_configs.config_json` host paths in `data/v2.db`.
7. Install the systemd user unit with `Restart=always`.
8. Apply always-on hardening (sudo prompt once): docker enabled at boot, `loginctl enable-linger`, lid suspend disabled, sleep targets masked, daily logrotate cron, unattended-upgrades.

Expect ~10 minutes total, dominated by `./container/build.sh` (Docker image bake).

## Step 5 — verify

```bash
onecli secrets list                    # should print the same count as on the Mac
~/nanoclaw/bin/ncl groups list
~/nanoclaw/bin/ncl messaging-groups list
systemctl --user start nanoclaw
tail -f ~/nanoclaw/logs/nanoclaw.log
```

Send a test message on the wired channel. First message after a fresh install respawns each agent's container — expect 10-20s delay. Subsequent messages should dispatch immediately.

## Common gotchas

- **`docker` denied** → user not in `docker` group. `sudo usermod -aG docker $USER` then log out/in.
- **`onecli secrets list` empty** → check `docker logs onecli-app-1` and `docker logs onecli-postgres-1`. Most common cause: `NEXTAUTH_SECRET` mismatch between bundle and `~/.env`. Re-run restore (idempotent).
- **`NODE_MODULE_VERSION` mismatch** for better-sqlite3 → `(cd ~/nanoclaw && pnpm rebuild better-sqlite3)`.
- **Channels with webhooks** (not Telegram/polling) → public URL likely changed. Re-register webhook on the platform side; tokens themselves are restored automatically by the OneCLI vault.

## Only thing left to the human

- BIOS/UEFI: set `AC Power Recovery = Power On` so the machine reboots itself after a power outage. The OS can't do this for you.

## Rollback

The restore is non-destructive on the Mac side — re-bundle and re-restore freely. If the Linux restore goes wrong:

```bash
systemctl --user stop nanoclaw 2>/dev/null
docker compose -f ~/.onecli/docker-compose.yml down -v   # also removes volumes
rm -rf ~/nanoclaw
# then git clone again and re-run restore.sh
```
