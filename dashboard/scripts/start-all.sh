#!/usr/bin/env bash
set -euo pipefail

# One-click startup for the full dashboard stack:
#   1. Dashboard server on :1111 (tmux session "dashboard-1111")
#   2. Nginx session proxy on :7001-:700N -> ttyd backends :8001-:800N
#
# Both underlying scripts are idempotent and non-destructive:
#   - start-dashboard.sh exits cleanly if :1111 is already serving.
#   - start-ttyd-sessions.sh regenerates+reloads nginx without touching live
#     ttyd backends or dashboard/state/sessions-state.json.
#
# This wrapper does NOT spawn scientist ttyd backends (8001-800N). Those are
# launched on demand from the dashboard UI when you tap an idle scientist card.
#
# For a destructive reset of slot backends + state, use reset-ttyd-sessions.sh
# directly instead of this wrapper.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/start-dashboard.sh" "$@"
"$SCRIPT_DIR/start-ttyd-sessions.sh"

cat <<'EOF'

dashboard stack is up:
  - dashboard:       http://127.0.0.1:1111
  - scientist slots: http://127.0.0.1:7001 ... :700N (per dashboard/sessions.json)

verify listeners:
  lsof -nP -iTCP -sTCP:LISTEN | rg ':(7001|7002|7003|7004|8001|8002|8003|8004|1111)\b'
EOF
