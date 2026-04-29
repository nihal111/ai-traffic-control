#!/bin/zsh
set -euo pipefail

cd ~/Code/AiTrafficControl/dashboard

# Stop the current dashboard listener if present.
pid="$(lsof -tiTCP:1111 -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [[ -n "${pid}" ]]; then
  kill "${pid}" || true
  sleep 1
fi

# Reuse an existing dashboard-1111 tmux session if present, otherwise create
# one. Lives on the default tmux socket so plain `tmux ls` shows it alongside
# scientist sessions.
tmux kill-session -t dashboard-1111 2>/dev/null || true
tmux new-session -d -s dashboard-1111 zsh -lc 'DASHBOARD_PORT=1111 node "$PWD/server.mjs"'

echo "dashboard started on :1111 in tmux session dashboard-1111"
