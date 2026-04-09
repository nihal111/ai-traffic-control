# AI Traffic Control

Run your personal AI agents continuously, and manage everything from one browser dashboard.

**Why this over Termius:** you get a live control-plane view first, instead of repeated connect -> SSH -> `tmux` just to check status.

AI Traffic Control is built for an individual operator with their own provider subscriptions who wants to be productive on the go:
- Keep multiple `tmux`-backed scientist slots running all day.
- Monitor active, idle, and unborn sessions at a glance.
- Resume or restart work quickly from mobile or desktop.
- Use hot-dial assistants (like Calendar Manager and Second Brain) for narrow, repeatable tasks.
- Track provider usage across Codex, Claude, and Gemini, including 5-hour and weekly windows where available, to make smarter subscription decisions.

The goal is simple: let agents handle odds-and-ends in the background while you are away from your desk, and give you a fast way to steer, nudge, and continue that work when needed.

Access model: this setup typically relies on Tailscale to reach the machine running the local dashboard (`localhost` on the host). Your phone/laptop connects to that same Tailscale network, which is why the local service is reachable remotely without opening it to the public internet.

Security posture: nothing is globally exposed by default. The dashboard and slot endpoints stay inside your private VPN boundary, so there is no public attack surface from open internet ingress. Operational risk is mostly within your own control: agent permissions, provider/tool access, and what you choose to run.

Project status: active and evolving (expect configuration and workflow changes between commits).

## Dashboard Highlights

- **Usage cards per provider:** Unified usage telemetry for Codex, Claude, and Gemini.
- **Hot-dial custom agents:** Lightweight assistants (for example Calendar Manager and Second Brain) with simplified launch flow.
- **Scientist fleet states:** Four scientists visible in different lifecycle modes (`active`, `idle`, `unborn`) with persona hats/badges where applicable.
- **Intent modal:** Structured session start flow with provider/template/persona controls for scientist launches.

## Visual Tour

### 1) Dashboard At A Glance (Usage + Hot-Dials + Scientist Status)

This view shows:
- Provider usage cards for Codex/Claude/Gemini.
- Hot-dial agents at the top of the fleet panel.
- Active scientist cards with current task/workdir context.

<a href="https://drive.google.com/file/d/179UyavAANO4LGiaEdBtOUlsnJBh_FJ1a/view?usp=drivesdk">
  <img src="https://drive.usercontent.google.com/download?id=179UyavAANO4LGiaEdBtOUlsnJBh_FJ1a&export=view" alt="Dashboard overview" height="520" />
</a>

GIF walkthrough: coming soon.

### 2) Browser Terminal Session (xterm-based CLI Control)

This view shows:
- The in-browser terminal used to drive a live CLI session from mobile/desktop.
- Command output stream and prompt loop inside the managed terminal surface.
- How AI Traffic Control lets you operate terminal sessions without opening a separate terminal app.

<a href="https://drive.google.com/file/d/1O7tuYj-3whmwcA4xieL-wykoFh0dZ6Us/view?usp=drivesdk">
  <img src="https://drive.usercontent.google.com/download?id=1O7tuYj-3whmwcA4xieL-wykoFh0dZ6Us&export=view" alt="Browser terminal view" height="520" />
</a>

GIF walkthrough: coming soon.

### 3) Intent Modal (Start Session Flow)

This view shows:
- Provider selection with live usage context.
- Template and persona controls.
- Working directory and recent-directory shortcuts before launch.

<a href="https://drive.google.com/file/d/1Hqo1obKcj0XxRYWk16M37dtXOuwwYZVs/view?usp=drivesdk">
  <img src="https://drive.usercontent.google.com/download?id=1Hqo1obKcj0XxRYWk16M37dtXOuwwYZVs&export=view" alt="Intent modal" height="520" />
</a>

GIF walkthrough: coming soon.

### 4) Scientist Fleet States (`active` / `idle` / `unborn`)

This view shows:
- Mixed scientist lifecycle states at once (`active`, `idle`, `unborn`).
- Fast triage context per scientist (task, workdir, turns, and recency).
- How to identify sessions that need intervention vs. sessions ready to start.

<a href="https://drive.google.com/file/d/1SPfvSTXpadh0AeBNuQk6TA6mZ963JMDA/view?usp=drivesdk">
  <img src="https://drive.usercontent.google.com/download?id=1SPfvSTXpadh0AeBNuQk6TA6mZ963JMDA&export=view" alt="Scientist fleet states" height="520" />
</a>

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
