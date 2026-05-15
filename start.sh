#!/bin/bash
export WEBHOOK_PORT=3001
echo "[$(date)] Starting, PID=$$, PWD=$(pwd)" >> /tmp/nanoclaw-start.log
exec /opt/homebrew/bin/node /Users/valerio/Desktop/nanoclaw/dist/index.js
