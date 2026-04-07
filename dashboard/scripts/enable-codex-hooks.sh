#!/usr/bin/env bash
set -euo pipefail

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG_FILE="$CODEX_DIR/config.toml"

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
