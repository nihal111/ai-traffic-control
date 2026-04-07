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

Shell hooks are currently feature-flagged off by default (`ENABLE_SHELL_HOOKS=0`) because `ZDOTDIR` injection still needs hardening to avoid ttyd input regressions. The hook writer and forwarders are tested and ready; shell hook activation remains gated until the integration path is stabilized.

## Codex hooks (milestone 5)

This repo includes local Codex hook wiring at `.codex/hooks.json` and a forwarder:
- `dashboard/scripts/codex-hook-forwarder.mjs`

Enable the feature flag once on this machine:

```bash
./dashboard/scripts/enable-codex-hooks.sh
```

When `codex` runs inside a spawned slot shell, native Codex hook payloads are forwarded into that slot's `events.jsonl` via the same shared writer.

Claude uses repo-local `.claude/settings.json` and the same forwarder, so Codex and Claude events land in the same per-slot schema.

Derived metrics are computed in the dashboard process:
- `TELEMETRY_INGEST_MS` (default `20000`)
- `TITLE_POLL_MS` (default `300000`)

Per-slot context usage is shown only when hooks provide an explicit percent field; otherwise the UI displays `N/A`.

## Fast Mobile UI Feedback

Capture a mobile screenshot of the dashboard (Playwright, `Pixel 7` by default):

```bash
./dashboard/scripts/mobile-screenshot.sh http://127.0.0.1:1111 dashboard/run/dashboard-mobile.png
```

Override device:

```bash
DEVICE="iPhone 13" ./dashboard/scripts/mobile-screenshot.sh
```

## Tests

```bash
cd dashboard
npm install
npm run test
```

This runs:
- Unit: `tests/unit/shell-hook-writer.test.mjs`
- E2E: `tests/e2e/terminal-smoke.spec.mjs` (spawns a slot, types via ttyd, asserts file write)

Or run from repo root:

```bash
./dashboard/scripts/test-dashboard.sh
```
