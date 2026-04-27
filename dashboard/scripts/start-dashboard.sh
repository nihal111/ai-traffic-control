#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DASHBOARD_PORT:-1111}"
SESSION="${DASHBOARD_TMUX_SESSION:-dashboard-1111}"

if [[ -n "${SSH_CONNECTION:-}" || -n "${SSH_CLIENT:-}" || -n "${SSH_TTY:-}" ]]; then
  if [[ "${ATC_STRICT_SSH_DASHBOARD:-0}" == "1" ]]; then
    echo "refusing to start dashboard from an SSH environment because ATC_STRICT_SSH_DASHBOARD=1 is set" >&2
    exit 1
  fi
  echo "warning: starting dashboard from an SSH environment; cloud profile switching may not match a local login session" >&2
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q node; then
  echo "dashboard already listening on :$PORT"
  exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" zsh -lc "ATC_STRICT_SSH_DASHBOARD=${ATC_STRICT_SSH_DASHBOARD:-0} DASHBOARD_PORT=$PORT node '$ROOT_DIR/server.mjs' $@"
echo "started dashboard on :$PORT in tmux session $SESSION with args: $@"
