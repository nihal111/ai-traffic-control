# Dashboard

Runs a lightweight dashboard on port `1111` to show:
- Codex usage (% used in 5-hour and weekly windows + reset times)
- Configured scientist slots from `sessions.json` with lifecycle state (`idle` / `active`)
- Tap-card actions (`idle -> spawn`, `active -> connect`) plus `×` kill control
- Per-slot metadata (`taskTitle`, `workdir`, `agentType`) from `state/sessions-state.json`
- Shell telemetry (`active since`, `last interaction`, live `cwd`, `last command`, `last event`, command duration) from `runtime/slots/<slot>/current/*`

## Start

```bash
# One-click: dashboard on :1111 + nginx session proxy on :7001-:700N
# Idempotent and non-destructive. Use this by default.
./dashboard/scripts/start-all.sh
```

Open: `http://<host>:1111`

Scientist `800x` ttyd backends are spawned on demand when you tap an idle scientist card. `start-all.sh` does not pre-spawn them.

### Advanced: underlying scripts

`start-all.sh` is a thin wrapper around these. Run them directly when you only need one:

```bash
# Dashboard server only (:1111, tmux session dashboard-1111)
./dashboard/scripts/start-dashboard.sh

# Nginx session proxy only (700x -> 800x), non-destructive
./dashboard/scripts/start-ttyd-sessions.sh

# Destructive: kill live 800x ttyd backends and reset slot state to idle
./dashboard/scripts/reset-ttyd-sessions.sh
```

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

Hooks are shell-level (`shell_start`, `preexec`, `precmd`, `chpwd`) and run even without Codex/Claude active.

Spawned sessions inject this env contract:
- `ATC_SLOT`
- `ATC_RUN_ID`
- `ATC_SLOT_DIR`
- `ATC_CURRENT_DIR`
- `ATC_EVENTS_FILE`
- `ATC_META_FILE`
- `ATC_DERIVED_FILE`
- `ATC_RUNTIME_ROOT`

`dashboard/scripts/shell-hook-writer.mjs` supports both env-only events (shell hooks) and JSON-over-stdin events (for Codex/Claude native hooks).
Shell hooks are enabled by default. Set `ENABLE_SHELL_HOOKS=0` only when explicitly debugging shell startup issues.

If `ATC_CURRENT_DIR` is unset and explicit output file paths are not provided, the fallback runtime files are written to a shared tmp-backed directory instead of `./dashboard/runtime/` under the current working directory. By default this is:

```text
${TMPDIR:-/tmp}/ai-traffic-control/<user>/dashboard-runtime/
```

## Native hooks (Codex, Claude, Gemini)

This repo includes hook wiring and a forwarder:
- `dashboard/scripts/codex-hook-forwarder.mjs`

Enable global hooks for all providers on this machine:

```bash
./dashboard/scripts/enable-codex-hooks.sh
```

This script:
- Enables `codex_hooks` feature in `~/.codex/config.toml` and installs global hooks in `~/.codex/hooks.json`.
- Installs global hooks in `~/.claude/settings.json`.
- Installs global hooks and enables hook system in `~/.gemini/settings.json`.

When a provider runs inside a spawned slot shell, native hook payloads are forwarded into that slot's `events.jsonl` via the same shared writer. This enables AI title summarization and telemetry even for non-shell events (like agent start/stop).

Derived metrics are computed in the dashboard process:
- `TELEMETRY_INGEST_MS` (default `2000`)
- `TITLE_POLL_MS` (default `300000`)

Per-slot context usage is shown only when hooks provide an explicit percent field; otherwise the UI displays `N/A`.

## AI Title Summarizer (Gemini)

Scientist and hot-dial session titles are automatically summarized from recent CLI transcript context and written back to:
- `dashboard/state/sessions-state.json` (`sessions.<slot>.taskTitle`)

Current trigger behavior:
- Runs on every `UserPromptSubmit` by default (`ATC_SUMMARY_TRIGGER_INTERVAL=1`)

Transcript source behavior:
- Preferred: `payload.transcript_path` from hook events, tailing the last `ATC_SUMMARY_TRANSCRIPT_LINES` lines (default `10`)
- Fallback: reconstruct recent exchanges from `events.jsonl` (`ATC_SUMMARY_EXCHANGE_COUNT`, default `10`)

Core files:
- Trigger + counter: `dashboard/scripts/shell-hook-writer.mjs`
- Summarizer worker: `dashboard/scripts/summarize-title.mjs`
- Logs: `dashboard/runtime/logs/summarizer.log`

Model and command configuration:
- `ATC_SUMMARIZER_CMD` (default: `gemini`)
- `ATC_SUMMARIZER_MODEL` (default: `gemini-3.1-flash-lite-preview`)
- `ATC_SUMMARY_TIMEOUT_MS` (default: `180000`)
- `ATC_NO_SUMMARIZER=1` disables summarization

Why this model default:
- `gemini-3.1-flash-lite-preview` is listed as Gemini's most cost-efficient model and is a strong fit for short title synthesis.
- If you prefer a stable non-preview fallback, set `ATC_SUMMARIZER_MODEL=gemini-2.5-flash-lite`.

## Provider launch + permissions mode

When an idle scientist is started from the dashboard, the backend:
1. Creates/respawns the slot tmux session/window.
2. Launches `ttyd` attached to that tmux pane.
3. Auto-types the selected provider command into the pane and presses Enter.

Default provider startup commands are defined in `dashboard/server.mjs`:
- `codex --dangerously-bypass-approvals-and-sandbox`
- `claude --dangerously-skip-permissions`
- `gemini --yolo`

These defaults can be overridden with env vars:
- `ATC_PROVIDER_BOOTSTRAP_CODEX`
- `ATC_PROVIDER_BOOTSTRAP_CLAUDE`
- `ATC_PROVIDER_BOOTSTRAP_GEMINI`

You can disable auto-launch entirely with:
- `ATC_AUTO_LAUNCH_PROVIDER=0`

Notes:
- Flags above were verified from local CLI help output (`codex --help`, `claude --help`, `gemini --help`).
- `ttyd` client title is pinned per slot via `titleFixed=<scientist-name>` in spawn code, so browser tabs show the scientist name.

## Claude Account Profile Management

If you have multiple Claude Pro/Max accounts, use `atc-profile` to switch between them from the CLI (and soon from the dashboard card itself).

Detailed runbook: `docs/claude-account-switching.md`

### Register a profile

First, log into the Claude account you want to register:

```bash
claude /login
```

Then register it under an alias:

```bash
node dashboard/scripts/atc-profile.mjs add primary
```

Repeat for each account:

```bash
claude /login    # log into a different Claude account
node dashboard/scripts/atc-profile.mjs add secondary
```

### List registered profiles

```bash
node dashboard/scripts/atc-profile.mjs list
```

Output shows all profiles with the active one marked with `*`:

```
Profiles:
 * primary    <you@example.com>    (added 04/16/2026)
   secondary  <other@example.com>  (added 04/16/2026)
```

### Switch profiles

```bash
node dashboard/scripts/atc-profile.mjs use secondary
```

This switches and validates the profile by checking `claude auth status --json` against the alias email.
Already-running sessions keep their original account.

Usage checks:
- Recommended (browser-independent): `codexbar usage --provider claude --source oauth --format json --pretty`
- Optional (depends on saved Firefox `sessionKey`): `codexbar usage --provider claude --source web --format json --pretty`

### Check the current profile

```bash
node dashboard/scripts/atc-profile.mjs current
```

### How it works

Profiles are stored in `~/.claude-profiles/`:

```
~/.claude-profiles/
├── profiles.json          # catalog: aliases, emails, active marker
├── primary.cred           # OAuth credential blob for "primary"
├── secondary.cred         # OAuth credential blob for "secondary"
└── .backup/               # timestamped backups before each switch
```

On macOS, Claude Code stores OAuth tokens in the system Keychain under service name `"Claude Code-credentials"`. Switching profiles atomically swaps that Keychain entry. All other `~/.claude` contents (settings, hooks, projects) remain shared across profiles.

## Where to edit this later

If you want to change spawn behavior in the future, edit:
- Provider command defaults/env mapping: `dashboard/server.mjs`
  at `PROVIDER_BOOT_COMMANDS`
- Auto-launch injection into tmux: `dashboard/server.mjs`
  at `launchProviderInTmuxSlot(...)`
- `ttyd` terminal options/title: `dashboard/server.mjs`
  at `spawnSessionBackend(...)`

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
- Unit: `tests/unit/*.test.mjs`
- E2E: `tests/e2e/*.spec.mjs` (includes terminal smoke, persona selector, tmux cwd tracking, and mobile behavior specs)

Or run from repo root:

```bash
./dashboard/scripts/test-dashboard.sh
```
