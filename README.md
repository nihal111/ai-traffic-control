# AI Traffic Control

Coordinate multiple long-running terminal sessions from one dashboard, with mobile-friendly `ttyd` access behind `nginx` and `tmux` persistence.

This repository is useful if you want to:
- Run several named terminal slots in parallel (for example: different agents/personas).
- See slot state and lightweight telemetry in a browser dashboard.
- Attach from desktop or phone without losing session history.

Project status: active and evolving (expect configuration and workflow changes between commits).

## Quick Start (5 minutes)

### 1) Prerequisites

Required tools on the host machine:
- `node` (tested in this repo with modern Node; `node@22` is used in some scripts)
- `tmux`
- `ttyd`
- `nginx` (default path assumed by scripts: `/opt/homebrew/opt/nginx/bin/nginx`)
- `jq` (for one health-check command)

### 2) Start session proxy + reset slots to idle

```bash
cd /Users/nihal/Code/AiTrafficControl
./dashboard/scripts/start-ttyd-sessions.sh
```

What this does:
- Regenerates dashboard-managed nginx config (`700x -> 800x` port mapping).
- Resets slot runtime state in `dashboard/state/sessions-state.json` to idle defaults.

### 3) Start the dashboard

```bash
cd /Users/nihal/Code/AiTrafficControl
./dashboard/scripts/start-dashboard.sh
```

Open:
- Dashboard: `http://127.0.0.1:1111`
- Mobile/slot endpoints: `http://127.0.0.1:7001` ... `:7004` (from `dashboard/sessions.json`)

### 4) Verify it is healthy

```bash
lsof -nP -iTCP -sTCP:LISTEN | rg ':(7001|7002|7003|7004|8001|8002|8003|8004|1111)\b'
tmux ls | rg 'dashboard-1111'
curl -sS http://127.0.0.1:1111/api/sessions | jq '{count: (.sessions|length), hasRecentWorkdirs: has("recentWorkdirs")}'
```

## Common Workflows

### Run dashboard tests

```bash
cd /Users/nihal/Code/AiTrafficControl/dashboard
npm install
npm test
```

Or from repo root:

```bash
./dashboard/scripts/test-dashboard.sh
```

### Change available scientist/session slots

Edit:
- `dashboard/sessions.json`

Then regenerate session proxy:

```bash
cd /Users/nihal/Code/AiTrafficControl
./dashboard/scripts/start-ttyd-sessions.sh
```

### Use standalone mobile ttyd stack (outside dashboard sessions)

```bash
cd /Users/nihal/Code/AiTrafficControl/nginx-ttyd
./scripts/start.sh
```

Default endpoint: `http://127.0.0.1:7680`

## Repository Layout

- `dashboard/`: Web dashboard, API, slot orchestration, telemetry ingest, tests.
- `nginx-ttyd/`: Standalone mobile ttyd + nginx overlay stack.
- `personas/`: Persona prompt docs used by session tooling.
- `data/`: Local data files used by runtime features.
- `agents.md`: Agent runbook with required post-change operational checks.
- `HANDOFF.md`: Current operational notes and change context.

## Architecture at a Glance

Dashboard-managed path:
1. Browser opens dashboard on `:1111`.
2. Dashboard manages slot lifecycle and metadata.
3. Session nginx proxy serves public slot ports (`:700x`) and forwards to slot backends (`:800x`).
4. Backends attach to `tmux`-backed shells through `ttyd`.
5. Shell/Codex/Claude hooks write events under `dashboard/runtime/slots/<slot>/current/`.

Standalone path:
1. Browser opens `nginx-ttyd` on `:7680`.
2. Nginx forwards to ttyd on `127.0.0.1:7682`.
3. Ttyd attaches to a persistent tmux session.

## Caveats

- `dashboard/scripts/start-ttyd-sessions.sh` intentionally resets slot state to idle and rewrites `dashboard/state/sessions-state.json`.
- Changing injected toolbar HTML requires regenerating/reloading nginx configs, not just a browser refresh.
- If only `nginx-ttyd/ttyd-mobile.css` or `nginx-ttyd/ttyd-mobile.js` changes, a hard refresh is usually enough (or bump `?v=` in nginx config if cached).

## Component Documentation

- Dashboard details: `dashboard/README.md`
- Mobile ttyd overlay details: `nginx-ttyd/README.md`
- Agent operation checklist: `agents.md`
- Current handoff notes: `HANDOFF.md`
