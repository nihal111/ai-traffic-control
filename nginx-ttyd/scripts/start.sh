#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NGINX_BIN="${NGINX_BIN:-/opt/homebrew/opt/nginx/bin/nginx}"
TTYD_BIN="${TTYD_BIN:-/opt/homebrew/bin/ttyd}"
TMUX_BIN="${TMUX_BIN:-tmux}"
NODE22_BIN="${NODE22_BIN:-/opt/homebrew/opt/node@22/bin/node}"

PUBLIC_PORT="${PUBLIC_PORT:-7680}"
BACKEND_PORT="${BACKEND_PORT:-7682}"
TMUX_SESSION="${TMUX_SESSION:-mobile}"
BACKEND_SESSION="${BACKEND_SESSION:-ttyd-backend}"
HISTORY_SESSION="${HISTORY_SESSION:-ttyd-history-server}"
ENABLE_HISTORY_SERVER="${ENABLE_HISTORY_SERVER:-0}"

if ! command -v "$TMUX_BIN" >/dev/null 2>&1; then
  echo "tmux not found" >&2
  exit 1
fi

if ! "$TMUX_BIN" has-session -t "$TMUX_SESSION" 2>/dev/null; then
  "$TMUX_BIN" new-session -d -s "$TMUX_SESSION"
  echo "created tmux session: $TMUX_SESSION"
fi

if ! lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN 2>/dev/null | grep -q ttyd; then
  # Ensure a stale session name doesn't block startup when ttyd isn't listening.
  if "$TMUX_BIN" has-session -t "$BACKEND_SESSION" 2>/dev/null; then
    "$TMUX_BIN" kill-session -t "$BACKEND_SESSION"
  fi

  "$TMUX_BIN" new-session -d -s "$BACKEND_SESSION" zsh -lc \
    "\"$TTYD_BIN\" -W -i 127.0.0.1 -p \"$BACKEND_PORT\" -t scrollback=100000 -t disableResizeOverlay=true -- \"$TMUX_BIN\" new-session -A -s \"$TMUX_SESSION\""
  echo "started ttyd backend on 127.0.0.1:$BACKEND_PORT in session $BACKEND_SESSION"
else
  echo "ttyd backend already listening on 127.0.0.1:$BACKEND_PORT"
fi

"$NGINX_BIN" -p "$ROOT_DIR/" -c "$ROOT_DIR/nginx.conf" -t
if lsof -nP -iTCP:"$PUBLIC_PORT" -sTCP:LISTEN 2>/dev/null | grep -q nginx; then
  "$NGINX_BIN" -p "$ROOT_DIR/" -c "$ROOT_DIR/nginx.conf" -s reload
  echo "reloaded nginx on :$PUBLIC_PORT"
else
  "$NGINX_BIN" -p "$ROOT_DIR/" -c "$ROOT_DIR/nginx.conf"
  echo "started nginx on :$PUBLIC_PORT"
fi

if [ "$ENABLE_HISTORY_SERVER" = "1" ]; then
  if ! lsof -nP -iTCP:17777 -sTCP:LISTEN 2>/dev/null | grep -q node; then
    "$TMUX_BIN" new-session -d -s "$HISTORY_SESSION" \
      "$NODE22_BIN $ROOT_DIR/tmux-history-server.js"
    echo "started optional history server on 127.0.0.1:17777"
  else
    echo "history server already listening on 127.0.0.1:17777"
  fi
fi

echo "ready: http://<host-ip>:$PUBLIC_PORT"
