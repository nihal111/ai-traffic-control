#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DASHBOARD_PORT:-1111}"
SESSION="${DASHBOARD_TMUX_SESSION:-dashboard-1111}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q node; then
  echo "dashboard already listening on :$PORT"
  exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" zsh -lc "DASHBOARD_PORT=$PORT node '$ROOT_DIR/server.mjs' $@"
echo "started dashboard on :$PORT in tmux session $SESSION with args: $@"
