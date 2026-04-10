# AI Traffic Control

Run real CLI agent workflows from your phone without giving up terminal power.

AI Traffic Control is a mobile-first control plane for people who rely on Codex/Claude/Gemini in the CLI and want the same operational control away from their desk.

## Why This Exists

### Pain Point 1: IM-driven agent interfaces are operationally fragile

For many users, agent workflows routed through chat apps (for example Telegram/WhatsApp bridges) break down when sessions become long-running, stateful, or tool-heavy.

Common failure modes:
- Message delivery != reliable execution state.
- Plugin/channel glitches can block or delay responses.
- Rich CLI ergonomics (shell tooling, structured logs, tight loops) are hard to preserve inside IM UX.

### Pain Point 2: Traditional mobile terminal tools are not enough

The usual model is: open mobile terminal app -> reconnect -> SSH -> attach tmux -> inspect each session manually.

That creates friction:
- High context-switch cost to understand "what needs attention now".
- No single operator dashboard across multiple agent sessions.
- Limited workflow customization for hot-starting repeatable agent tasks.

## What AI Traffic Control Gives You

AI Traffic Control combines a browser terminal surface (xterm.js + ttyd + tmux) with an operator dashboard.

Core capabilities:
- Fleet view of AI sessions with lifecycle states (`active`, `idle`, `unborn`).
- In-browser terminal control for each slot from mobile or desktop.
- Provider usage telemetry (Codex/Claude/Gemini) for 5-hour and weekly usage awareness where available.
- Hot-dial agents for one-tap launches of specialized workflows.
- Intent modal with provider/template/persona/workdir controls before spawn.
- Session title summarization from recent transcript context.

Outcome: you can steer serious CLI work on the go, instead of running a degraded “chat bot” version of your workflow.

## At A Glance Comparison

| Workflow Model | Common Friction | AI Traffic Control Difference |
| --- | --- | --- |
| IM-based agent bridge | Message transport and execution state can diverge; limited CLI ergonomics | Keeps you in terminal-native workflows with direct session control |
| Mobile terminal app only | Reconnect and inspect sessions one-by-one; limited fleet visibility | Unified dashboard + slot state + telemetry for fast triage |
| Raw tmux over SSH | Powerful but high manual overhead from phone | One-tap hot-dials, guided spawn flow, and browser terminal UX |

## Positioning in One Line

AI Traffic Control is a control plane for mobile CLI agent operations, not a chat wrapper.

## Who This Is For

- Builders running multiple long-lived AI coding/research sessions.
- Operators who need fast intervention loops from phone + desktop.
- Individuals optimizing subscription quota windows across providers.
- Users who want deep customization over session launch and runtime behavior.

## Visual Tour

### 1) Dashboard At A Glance (Usage + Hot-Dials + Scientist Status)

This view shows:
- Provider usage cards for Codex/Claude/Gemini.
- Hot-dial agents at the top of the fleet panel.
- Active scientist cards with current task/workdir context.

<p align="center">
  <a href="https://drive.google.com/file/d/179UyavAANO4LGiaEdBtOUlsnJBh_FJ1a/view?usp=drivesdk">
    <img src="https://drive.usercontent.google.com/download?id=179UyavAANO4LGiaEdBtOUlsnJBh_FJ1a&export=view" alt="Dashboard overview" height="780" />
  </a>
</p>

GIF walkthrough: coming soon.

### 2) Browser Terminal Session (xterm-based CLI Control)

This view shows:
- The in-browser terminal used to drive a live CLI session from mobile/desktop.
- Command output stream and prompt loop inside the managed terminal surface.
- How AI Traffic Control lets you operate terminal sessions without opening a separate terminal app.

<p align="center">
  <a href="https://drive.google.com/file/d/1O7tuYj-3whmwcA4xieL-wykoFh0dZ6Us/view?usp=drivesdk">
    <img src="https://drive.usercontent.google.com/download?id=1O7tuYj-3whmwcA4xieL-wykoFh0dZ6Us&export=view" alt="Browser terminal view" height="780" />
  </a>
</p>

GIF walkthrough: coming soon.

### 3) Intent Modal (Start Session Flow)

This view shows:
- Provider selection with live usage context.
- Template and persona controls.
- Working directory and recent-directory shortcuts before launch.

<p align="center">
  <a href="https://drive.google.com/file/d/1Hqo1obKcj0XxRYWk16M37dtXOuwwYZVs/view?usp=drivesdk">
    <img src="https://drive.usercontent.google.com/download?id=1Hqo1obKcj0XxRYWk16M37dtXOuwwYZVs&export=view" alt="Intent modal" height="780" />
  </a>
</p>

GIF walkthrough: coming soon.

### 4) Scientist Fleet States (`active` / `idle` / `unborn`)

This view shows:
- Mixed scientist lifecycle states at once (`active`, `idle`, `unborn`).
- Fast triage context per scientist (task, workdir, turns, and recency).
- How to identify sessions that need intervention vs. sessions ready to start.

<p align="center">
  <a href="https://drive.google.com/file/d/1SPfvSTXpadh0AeBNuQk6TA6mZ963JMDA/view?usp=drivesdk">
    <img src="https://drive.usercontent.google.com/download?id=1SPfvSTXpadh0AeBNuQk6TA6mZ963JMDA&export=view" alt="Scientist fleet states" height="780" />
  </a>
</p>

GIF walkthrough: coming soon.

### 5) Additional Visuals

- Persona hat/badge deep-dive screenshots: coming soon.

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
cd ~/Code/AiTrafficControl
./dashboard/scripts/start-ttyd-sessions.sh
```

What this does:
- Regenerates dashboard-managed nginx config (`700x -> 800x` port mapping).
- Resets slot runtime state in `dashboard/state/sessions-state.json` to idle defaults.

### 3) Start the dashboard

```bash
cd ~/Code/AiTrafficControl
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

## Security Model

Typical access model:
- Dashboard runs locally on the host.
- Remote phone/laptop access is commonly handled through a private VPN (for example Tailscale).

Security posture:
- Nothing is publicly exposed by default.
- Slot endpoints and dashboard remain inside your private network boundary.
- Main operational risks are in your own agent permissions, tool access, and execution policy.

## Common Workflows

### Configure AI session title summarizer

The dashboard can auto-update each slot title (`taskTitle`) based on the latest CLI conversation direction.

Main knobs:
- `ATC_SUMMARY_TRIGGER_INTERVAL` (default `1`; run summarizer every prompt)
- `ATC_SUMMARIZER_CMD` (default `gemini`)
- `ATC_SUMMARIZER_MODEL` (default `gemini-3.1-flash-lite-preview`)
- `ATC_SUMMARY_TRANSCRIPT_LINES` (default `10`)
- `ATC_SUMMARY_TIMEOUT_MS` (default `180000`)
- `ATC_NO_SUMMARIZER=1` to disable

Implementation reference:
- `dashboard/scripts/shell-hook-writer.mjs`
- `dashboard/scripts/summarize-title.mjs`
- `dashboard/runtime/logs/summarizer.log`

### Run dashboard tests

```bash
cd ~/Code/AiTrafficControl/dashboard
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
cd ~/Code/AiTrafficControl
./dashboard/scripts/start-ttyd-sessions.sh
```

### Use standalone mobile ttyd stack (outside dashboard sessions)

```bash
cd ~/Code/AiTrafficControl/nginx-ttyd
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
