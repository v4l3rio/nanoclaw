---
name: move-to-linux
description: Restore a NanoClaw install on this Linux machine from a Mac-produced encrypted bundle. Detects the distro, installs any missing dependencies (asking for sudo once), then restores code + secrets + OneCLI vault and configures the always-on systemd service.
---

# /move-to-linux

End-to-end restore on the **destination Linux machine**. Two transfer channels:

- **Code** → `git clone https://github.com/v4l3rio/nanoclaw.git` (public, no secrets)
- **Secrets + state** → encrypted bundle file produced on the Mac by `scripts/migrate/bundle.sh`

The skill auto-detects the distro, installs missing tools, then chains into `restore.sh`. User confirms once at the start; afterwards it runs unattended until the systemd service is up.

---

## Step 0 — confirm scope with the user

Ask, in this order, ALL up-front (don't drip-feed prompts):

1. Full path to the encrypted bundle (e.g. `~/Downloads/nanoclaw-bundle.enc`).
2. Destination directory (default `~/nanoclaw`).
3. Permission to install missing system packages with `sudo` (yes/no).

If the user says "no" to #3, stop and tell them which packages are missing so they install them manually, then re-invoke the skill.

---

## Step 1 — detect environment

Run:

```bash
. /etc/os-release && echo "$ID $VERSION_ID $ID_LIKE"
uname -m
```

Branch on `$ID` / `$ID_LIKE`:

| Detected | Package manager | Notes |
|---|---|---|
| `ubuntu`, `debian`, `linuxmint`, `pop`, `*` containing `debian` | `apt-get` | most common path |
| `fedora`, `rhel`, `centos`, `*` containing `rhel`/`fedora` | `dnf` | |
| `arch`, `manjaro` | `pacman` | |
| `alpine` | `apk` | rare, mostly WSL |
| anything else | unknown | tell user to install manually |

If WSL: also detect via `grep -qi microsoft /proc/version` — Docker setup differs slightly (user often runs Docker Desktop on Windows side instead of native).

---

## Step 2 — check what's installed

For each of these tools, run `command -v <tool>` and record which are MISSING:

| Tool | Required version | Why |
|---|---|---|
| `openssl` | any | decrypt bundle |
| `rsync` | any | copy data/ groups/ |
| `git` | any | already cloned the repo but checked anyway |
| `tar`, `gzip` | any | bundle archive |
| `curl` | any | bootstrap installs of bun |
| `docker` | any (CE) | run agent containers + OneCLI |
| `node` | **≥ 20** | host runtime |
| `pnpm` | any | host package manager |
| `bun` | any | agent-runner runtime |
| `jq` | any | nice-to-have for debugging |

For `node`, also check the version: `node -v` — if < 20, treat as MISSING (will reinstall via NodeSource).

---

## Step 3 — install the missing pieces

If everything is present, skip to Step 4. Otherwise, run **only the install blocks for missing tools**, in this order (some have dependencies):

### Debian/Ubuntu

```bash
# Base packages (only run if any of these are missing)
sudo apt-get update -y
sudo apt-get install -y openssl rsync git ca-certificates curl gzip tar jq

# Docker (only if missing)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  sudo systemctl enable --now docker
fi

# Node ≥ 20 (only if missing or too old)
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# pnpm (only if missing)
command -v pnpm >/dev/null || sudo npm install -g pnpm

# Bun (only if missing) — user-local install, no sudo
command -v bun >/dev/null || (curl -fsSL https://bun.sh/install | bash && \
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc && \
  export PATH="$HOME/.bun/bin:$PATH")
```

### Fedora/RHEL

```bash
sudo dnf install -y openssl rsync git ca-certificates curl gzip tar jq

if ! command -v docker >/dev/null; then
  sudo dnf install -y dnf-plugins-core
  sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  sudo systemctl enable --now docker
fi

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 20 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf install -y nodejs
fi

command -v pnpm >/dev/null || sudo npm install -g pnpm
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
```

### Arch/Manjaro

```bash
sudo pacman -S --needed --noconfirm openssl rsync git ca-certificates curl gzip tar jq docker nodejs npm
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
command -v pnpm >/dev/null || sudo npm install -g pnpm
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
```

### Unknown distro

Print a clear message: which tools are missing, link to each project's install docs, and stop.

---

## Step 4 — the docker-group gotcha

If you just added the user to the `docker` group, the current shell still **doesn't** have it in its group list. Test:

```bash
docker ps >/dev/null 2>&1 && echo OK || echo NEEDS_RELOGIN
```

If `NEEDS_RELOGIN`, tell the user verbatim:

> Ho aggiunto il tuo utente al gruppo `docker`. Per usarlo senza `sudo` devi fare logout e login (oppure riavviare). Alternativa rapida: lancia `newgrp docker` in questa shell, poi ri-invoca `/move-to-linux`.

Then stop. Don't try to work around with `sudo docker` — the restore script and nanoclaw runtime expect rootless docker access.

---

## Step 5 — clone the repo (if not already)

```bash
if [ ! -d "$DEST/.git" ]; then
  git clone https://github.com/v4l3rio/nanoclaw.git "$DEST"
fi
```

Use the destination directory the user gave at Step 0.

---

## Step 6 — run the restore

```bash
cd "$DEST"
bash scripts/migrate/restore.sh "$BUNDLE_PATH" "$DEST"
```

The script handles everything from here: decrypts (prompts the user for the passphrase), restores `.env`/`data`/`groups`, brings up the OneCLI vault (Postgres dump + master key volume + NEXTAUTH_SECRET), installs the JS deps, patches DB paths, builds the agent container, installs the systemd unit, and applies always-on hardening with a single sudo prompt.

While it runs, **don't interrupt**. The Docker image build alone takes 3-5 minutes.

---

## Step 7 — verify and start

```bash
onecli secrets list                    # expected count printed by restore.sh at the end
"$DEST"/bin/ncl groups list
"$DEST"/bin/ncl messaging-groups list
systemctl --user enable --now nanoclaw
systemctl --user status nanoclaw
tail -f "$DEST"/logs/nanoclaw.log
```

Have the user send a test message on the wired channel. First message respawns each agent's container — expect 10-20s. Subsequent messages dispatch immediately.

---

## Common gotchas

- **`docker` denied**: the docker-group re-login dance (Step 4). Verify with `groups | grep docker`.
- **`onecli secrets list` empty**: check `docker logs onecli-app-1`. Most common cause is `NEXTAUTH_SECRET` mismatch between bundle and `~/.env`. Re-run `restore.sh` — it's idempotent.
- **`NODE_MODULE_VERSION` mismatch** for `better-sqlite3`: `(cd $DEST && pnpm rebuild better-sqlite3)`.
- **Channels with webhooks** (not Telegram polling): the public URL is different from the Mac. Re-register the webhook on the platform side. The auth token itself is already restored via OneCLI.
- **WSL2**: `systemctl --user` works but `loginctl enable-linger` is a no-op (services stop when WSL stops). Tell the user they need to keep WSL running or use `wsl --no-distribution` tricks.

---

## What's left to the human (and only the human)

- BIOS/UEFI: `AC Power Recovery = Power On` so the box reboots itself after a blackout. No OS-level command can do this.

---

## Rollback

```bash
systemctl --user stop nanoclaw 2>/dev/null
docker compose -f ~/.onecli/docker-compose.yml down -v   # also wipes volumes
rm -rf "$DEST"
# then re-invoke /move-to-linux from scratch
```
