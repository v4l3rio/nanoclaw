# Migrate NanoClaw to a new machine

Minimal steps to move a running NanoClaw install to another machine (Ubuntu or any Linux).
No re-authentication required — sessions and credentials travel with you.

---

## Step 1 — Pack the secrets (on the source machine)

```bash
cd /path/to/nanoclaw

tar -czf nanoclaw-data.tar.gz \
  .env \
  data/ \
  store/
```

Copy `nanoclaw-data.tar.gz` to a USB stick or transfer it securely (scp, rsync over LAN, etc.).

> `data/` holds channel sessions (Telegram auth, etc.) and runtime env files.
> `store/` holds the SQLite chat history. Skip it if you don't need history on the new machine.

---

## Step 2 — Prerequisites (on the new Ubuntu machine)

```bash
# Docker
sudo apt update && sudo apt install -y docker.io
sudo usermod -aG docker $USER   # log out and back in after this

# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## Step 3 — Clone and restore

```bash
git clone <your-fork-url> nanoclaw
cd nanoclaw

# Copy the archive from USB (adjust the mount path)
cp /media/$USER/<usb-label>/nanoclaw-data.tar.gz .
tar -xzf nanoclaw-data.tar.gz
rm nanoclaw-data.tar.gz
```

---

## Step 4 — Build

```bash
npm ci
npm run build
./container/build.sh
```

---

## Step 5 — Run as a systemd service

```bash
# Install the service unit (see launchd/nanoclaw.service for the template)
PROJECT_ROOT="$(pwd)"
NODE_PATH="$(which node)"

sed \
  -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
  -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
  -e "s|{{USER}}|$USER|g" \
  launchd/nanoclaw.service \
  | sudo tee /etc/systemd/system/nanoclaw.service

sudo systemctl daemon-reload
sudo systemctl enable --now nanoclaw

# Check logs
journalctl -u nanoclaw -f
```

---

## That's it

NanoClaw starts on boot, reconnects to Telegram (or other channels) using the sessions you copied, and picks up right where you left off.

To update in the future: `git pull && npm run build && ./container/build.sh && sudo systemctl restart nanoclaw`
