# Agent Runbook

This file defines required post-change steps for this repo so agents do not rely on user reminders.

Privacy note: documentation must not include real names or real email addresses in examples.

## 1) Dashboard app (`dashboard/`)

### 1.1 If `dashboard/server.mjs` changes

Always restart the running dashboard process.

1. `cd ~/Code/AiTrafficControl/dashboard`
2. `tmux kill-session -t dashboard-1111 2>/dev/null || true`
3. `./scripts/start-dashboard.sh`
4. Verify process is live:
   - `lsof -nP -iTCP:1111 -sTCP:LISTEN`
   - `tmux ls | rg 'dashboard-1111'`
5. Verify API responds:
   - `curl -sS http://127.0.0.1:1111/api/sessions | jq '{count: (.sessions|length), hasRecentWorkdirs: has("recentWorkdirs"), recentWorkdirs: .recentWorkdirs}'`

Important:
- `./scripts/start-dashboard.sh` exits early if any Node process is already listening on port `1111`.
- Always kill `dashboard-1111` first for reliable deploy of changes.

### 1.2 If session proxy/script config changes (`dashboard/scripts/start-ttyd-sessions.sh`, `dashboard/sessions.json`)

Rebuild and reload dashboard-managed nginx session proxy:

1. `cd ~/Code/AiTrafficControl/dashboard`
2. `./scripts/start-ttyd-sessions.sh`
3. Validate listeners:
   - `lsof -nP -iTCP -sTCP:LISTEN | rg ':(7001|7002|7003|7004|8001|8002|8003|8004|1111)\b'`

Important behavior:
- `start-ttyd-sessions.sh` resets slot state to idle and rewrites `dashboard/state/sessions-state.json`.
- Running it intentionally clears active slot runtime metadata and can clear persisted extras stored only in that file.

### 1.3 If hook wiring changes (`.codex/hooks.json`, `.claude/settings.json`, `dashboard/scripts/codex-hook-forwarder.mjs`, `dashboard/scripts/shell-hook-writer.mjs`)

1. Ensure Codex hooks feature is enabled locally:
   - `cd ~/Code/AiTrafficControl`
   - `./dashboard/scripts/enable-codex-hooks.sh`
2. Run dashboard tests:
   - `cd ~/Code/AiTrafficControl/dashboard`
   - `npm test`
3. Verify hook output files still update during a spawned session:
   - `dashboard/runtime/slots/<slot>/current/events.jsonl`
   - `dashboard/runtime/slots/<slot>/current/meta.json`
   - `dashboard/runtime/slots/<slot>/current/derived.json`

### 1.4 Standard dashboard test command

From `dashboard/`:
- `npm test`

Or from repo root:
- `./dashboard/scripts/test-dashboard.sh`

## 2) Mobile terminal proxy (`nginx-ttyd/`)

### 2.1 If only CSS/JS asset files change (`nginx-ttyd/ttyd-mobile.css`, `nginx-ttyd/ttyd-mobile.js`)

- Usually no nginx restart required.
- Hard-refresh browser tab (`Cmd+Shift+R`).
- If stale cache persists, bump `?v=` in injected asset URLs (in `nginx-ttyd/nginx.conf` and dashboard session nginx template).

### 2.2 If injected toolbar HTML/sub_filter config changes

1. Update:
   - `nginx-ttyd/nginx.conf`
   - `dashboard/scripts/start-ttyd-sessions.sh` (template for generated session nginx config)
2. Regenerate session nginx config:
   - `cd ~/Code/AiTrafficControl/dashboard`
   - `./scripts/start-ttyd-sessions.sh`
3. Reload standalone nginx stack:
   - `cd ~/Code/AiTrafficControl/nginx-ttyd`
   - `./scripts/start.sh`
4. Hard-refresh browser tabs.

### 2.3 Validate nginx/ttyd baseline listeners

- `lsof -nP -iTCP -sTCP:LISTEN | rg ':(7680|7682|17777)\b'`
- `tmux ls`

## 3) Completion checklist for agents

Before handing off code changes:

1. Restart any long-running process affected by edited files.
2. Run relevant test suite(s) for changed area.
3. Verify key runtime endpoint/listener for that area.
4. Report exact commands run and verification results in final update.

## 4) Calendar manager integration notes

When using `~/Code/CalendarAutomation`:

1. Use `create_event(...)` / `update_event(...)` wrappers for attendee writes.
2. Attendee names (for example, `Contact Person`) resolve via `.local/contacts.yaml`.
3. Attendees must be written as GCSA `Attendee` objects internally; avoid assigning raw strings directly on fetched event objects.
4. Ensure Google send-updates behavior is enabled on writes so attendee email notifications are sent.
