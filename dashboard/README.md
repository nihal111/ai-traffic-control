# Dashboard

Runs a lightweight dashboard on port `1111` to show:
- Codex usage (% used in 5-hour and weekly windows + reset times)
- Configured scientist slots from `sessions.json` with lifecycle state (`idle` / `active`)
- Tap-card actions (`idle -> spawn`, `active -> connect`) plus `×` kill control
- Per-slot metadata (`taskTitle`, `workdir`, `agentType`) from `state/sessions-state.json`
- Shell telemetry (`active since`, `last interaction`, live `cwd`) from `runtime/slots/<slot>/current/*`

## Start

```bash
# Reset all slot backends to idle and start/reload nginx proxy (public 700x -> backend 800x)
./dashboard/scripts/start-ttyd-sessions.sh

# Start dashboard in tmux on :1111
./dashboard/scripts/start-dashboard.sh
```

Open: `http://<host>:1111`

## Session mapping

Edit `dashboard/sessions.json`:

```json
[
  { "name": "Feynman", "publicPort": 7001, "backendPort": 8001, "description": "Feynman session" }
]
```

`publicPort` is what you open on phone. `backendPort` is the local ttyd backend port proxied by nginx.

## Runtime telemetry

Each spawned slot writes shell hook events into:

- `dashboard/runtime/slots/<slot>/current/events.jsonl`
- `dashboard/runtime/slots/<slot>/current/meta.json`
- `dashboard/runtime/slots/<slot>/current/derived.json`

Hooks are shell-level (`preexec`, `precmd`, `chpwd`) and run even without Codex/Claude active.

Spawned sessions inject this env contract:
- `ATC_SLOT`
- `ATC_RUN_ID`
- `ATC_SLOT_DIR`
- `ATC_CURRENT_DIR`
- `ATC_EVENTS_FILE`
- `ATC_META_FILE`
- `ATC_DERIVED_FILE`

`dashboard/scripts/shell-hook-writer.mjs` supports both env-only events (shell hooks) and JSON-over-stdin events (for upcoming Codex/Claude native hooks).

## Fast Mobile UI Feedback

Capture a mobile screenshot of the dashboard (Playwright, `Pixel 7` by default):

```bash
./dashboard/scripts/mobile-screenshot.sh http://127.0.0.1:1111 dashboard/run/dashboard-mobile.png
```

Override device:

```bash
DEVICE="iPhone 13" ./dashboard/scripts/mobile-screenshot.sh
```
