#!/bin/zsh
set -euo pipefail

cd ~/Code/AiTrafficControl/dashboard

# Stop the current dashboard listener if present.
pid="$(lsof -tiTCP:1111 -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [[ -n "${pid}" ]]; then
  kill "${pid}" || true
  sleep 1
fi

# Use a dedicated tmux socket so this server does not inherit the existing
# SSH-derived tmux environment.
tmux -L atc-dashboard-gui kill-server 2>/dev/null || true
tmux -L atc-dashboard-gui new-session -d -s dashboard-1111-gui zsh -lc 'DASHBOARD_PORT=1111 node "$PWD/server.mjs"'

echo "dashboard started on :1111 via GUI-owned tmux socket atc-dashboard-gui"
