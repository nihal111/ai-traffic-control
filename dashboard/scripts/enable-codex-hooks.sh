#!/usr/bin/env bash
set -euo pipefail

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG_FILE="$CODEX_DIR/config.toml"
HOOKS_FILE="$CODEX_DIR/hooks.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK_FORWARDER="$REPO_ROOT/dashboard/scripts/codex-hook-forwarder.mjs"

mkdir -p "$CODEX_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<'TOML'
[features]
codex_hooks = true
TOML
  echo "created $CONFIG_FILE with codex_hooks enabled"
  exit 0
fi

tmp_file="${CONFIG_FILE}.$$.tmp"
awk '
BEGIN {
  in_features = 0;
  saw_features = 0;
  wrote_codex_hooks = 0;
}
function write_hook_if_needed() {
  if (in_features && !wrote_codex_hooks) {
    print "codex_hooks = true";
    wrote_codex_hooks = 1;
  }
}
/^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
  write_hook_if_needed();
  in_features = ($0 ~ /^[[:space:]]*\[features\][[:space:]]*$/);
  if (in_features) {
    saw_features = 1;
    wrote_codex_hooks = 0;
  }
  print;
  next;
}
{
  if (in_features && $0 ~ /^[[:space:]]*codex_hooks[[:space:]]*=/) {
    if (!wrote_codex_hooks) {
      print "codex_hooks = true";
      wrote_codex_hooks = 1;
    }
    next;
  }
  print;
}
END {
  write_hook_if_needed();
  if (!saw_features) {
    print "";
    print "[features]";
    print "codex_hooks = true";
  }
}
' "$CONFIG_FILE" > "$tmp_file"

mv "$tmp_file" "$CONFIG_FILE"
echo "enabled codex_hooks in $CONFIG_FILE"

# Install global Codex hooks so sessions started in other workdirs still forward
# UserPromptSubmit/Stop events into the dashboard writer.
cat > "$HOOKS_FILE" <<JSON
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "ATC_PROVIDER=codex node \"$HOOK_FORWARDER\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ATC_PROVIDER=codex node \"$HOOK_FORWARDER\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ATC_PROVIDER=codex node \"$HOOK_FORWARDER\""
          }
        ]
      }
    ]
  }
}
JSON

echo "wrote global hooks to $HOOKS_FILE"

# ── Claude global hooks ────────────────────────────────────────
# Claude's project-level hooks (.claude/settings.json in the repo) only fire
# when Claude is launched from the ATC project directory.  Install hooks into
# the global ~/.claude/settings.json so sessions spawned from any CWD still
# forward events to the dashboard.
CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"

# Merge hooks into existing settings (preserve model, permissions, etc.)
node -e "
  const fs = require('fs');
  const settingsPath = process.argv[1];
  const forwarder = process.argv[2];
  const cmd = 'ATC_PROVIDER=claude node \"' + forwarder + '\"';
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: cmd }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd }] }],
  };
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  existing.hooks = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
" "$CLAUDE_SETTINGS" "$HOOK_FORWARDER"

echo "merged claude hooks into $CLAUDE_SETTINGS"
