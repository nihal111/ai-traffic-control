# AI Traffic Control Implementation Plan

This document formalizes implementation milestones for slot orchestration and lightweight telemetry.

## Design Principles
- Keep slots deterministic and reusable (`Feynman`, `Einstein`, `Gauss`, `Fermi`).
- Prefer low-complexity instrumentation first (shell-level hooks), then agent-specific hooks.
- Avoid brittle process/TTY inference for agent-specific stats.
- Keep storage bounded (small rolling history, not full indefinite transcripts).

## Slot Model
- A slot is a stable identity with fixed ports and reusable runtime.
- `Kill` terminates the live process for that slot and marks it idle.
- `Spawn` reuses the same slot name/ports and creates a new `runId`.
- Runtime data is partitioned by slot and run.

Runtime paths:
- `dashboard/runtime/slots/<slot>/current/meta.json`
- `dashboard/runtime/slots/<slot>/current/events.jsonl`
- `dashboard/runtime/slots/<slot>/current/derived.json`
- `dashboard/runtime/slots/<slot>/current/title.txt`
- `dashboard/runtime/slots/<slot>/runs/<runId>/...` (archived)

Retention:
- Keep `current` plus last `N` archived runs (default `N=3`).

## Milestone 1 (Done): Lifecycle UX + Control Plane
Scope:
- Idle/active slot lifecycle in dashboard.
- Tap card behavior (`idle -> spawn`, `active -> connect`) and kill button.
- Public proxy + backend ports.

Status:
- Implemented.

## Milestone 2 (Done): Basic Slot Metadata
Scope:
- Store `taskTitle`, `workdir`, `agentType`, timestamps in slot state.

Status:
- Implemented (baseline fields and state persistence).

## Milestone 3 (Done): Shell-Level Hooks (Required Before Agent Hooks)
Scope:
- Add shell-native hooks in each spawned zsh session:
  - `preexec`
  - `precmd`
  - `chpwd`
- Emit lightweight JSON events independent of Codex/Claude.

Event payload fields:
- `ts`
- `slot`
- `runId`
- `eventType` (`shell_start`, `preexec`, `precmd`, `chpwd`)
- `cwd`
- `command` (for `preexec`)
- `durationMs` (optional if derived from preexec/precmd)

Files written:
- Append event rows to `current/events.jsonl`.
- Update `current/meta.json` with `activeSince`, `lastInteractionAt`, latest `cwd`.
- Update `current/derived.json` for dashboard reads.

Acceptance criteria:
- Spawned slot creates `current/*` files.
- `cwd` changes and command activity update timestamps reliably.
- Dashboard shows `active for`, `last interaction`, and live workdir without any agent running.

Status:
- Implemented with per-slot runtime files under `dashboard/runtime/slots/<slot>/current`.
- Hooked zsh `preexec`, `precmd`, `chpwd`, plus `shell_start` event emission through `dashboard/scripts/shell-hook-writer.mjs`.
- Dashboard session payload now merges `derived.json` telemetry for live timing/workdir display.

## Milestone 4 (Done): Shared Hook Writer + Env Contract
Scope:
- Standardize per-slot runtime env vars injected at spawn:
  - `ATC_SLOT`
  - `ATC_RUN_ID`
  - `ATC_SLOT_DIR`
  - `ATC_CURRENT_DIR`
  - `ATC_EVENTS_FILE`
  - `ATC_META_FILE`
- Implement a single hook writer script that:
  - reads JSON from stdin
  - enriches with `ATC_*` metadata
  - appends to `ATC_EVENTS_FILE`

Fallback:
- If `ATC_EVENTS_FILE` missing, append to `dashboard/runtime/unassigned-events.jsonl`.

Acceptance criteria:
- All shell and agent hooks route to deterministic slot files via env vars.

Status:
- Implemented env contract injection at session spawn (`ATC_*` vars above).
- Shared writer now accepts both env variables and optional JSON stdin payload for normalized event ingestion.
- Fallback sink is implemented at `dashboard/runtime/unassigned-events.jsonl`.

## Milestone 5 (Done): Codex Native Hooks Integration
Scope:
- Enable Codex hooks via `~/.codex/config.toml` feature flag:
  - `[features] codex_hooks = true`
- Configure `hooks.json` to call the shared hook writer for:
  - `SessionStart`
  - `UserPromptSubmit`
  - `PreToolUse`
  - `PostToolUse`
  - `Stop`

Codex hook output handling:
- Persist key fields from stdin payload, including:
  - `session_id`, `turn_id`, `cwd`, `model`, `transcript_path`
  - `tool_name`, `tool_input.command`, `tool_response` where present

Acceptance criteria:
- Codex turns/tool events appear in slot `events.jsonl`.
- Dashboard shows Codex-specific activity only when Codex events exist.

Status:
- Added repo-local `.codex/hooks.json` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
- Added `dashboard/scripts/codex-hook-forwarder.mjs` to forward Codex hook payloads to the shared writer.
- Added `dashboard/scripts/enable-codex-hooks.sh` and enabled `codex_hooks = true` in `~/.codex/config.toml`.
- Validated ingestion with simulated Codex payloads and `Stop` JSON response handling.

## Milestone 6 (Done): Claude Native Hooks Integration
Scope:
- Configure Claude hooks to call the same shared hook writer.
- Normalize Claude hook payload into the same event schema as Codex.

Acceptance criteria:
- Claude events appear in slot `events.jsonl` with `provider=claude`.
- Dashboard shows Claude-specific activity only when Claude events exist.

Status:
- Added repo-local `.claude/settings.json` hook config for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
- Reused shared forwarder/writer pipeline so Claude and Codex land in the same event stream format.
- Validated with simulated Claude-style payloads forwarded into slot runtime files.

## Milestone 7 (Done): Derived Metrics + Title Generation
Scope:
- Background ingestor computes and updates `derived.json` from events.
- 5-minute title poll:
  - summarize last 10 interactions
  - write `current/title.txt`
  - allow manual title override lock later

Metrics to show:
- `activeSince`
- `lastInteractionAt`
- `lastUserPromptAt`
- `lastAssistantStopAt`
- `agentType`
- `turnCount`
- `title`

Acceptance criteria:
- Blank agent metrics for plain shells.
- Populated metrics/title only when Codex/Claude hooks emit events.

Status:
- Added background telemetry ingestion (`TELEMETRY_INGEST_MS`) to compute derived metrics from per-slot events.
- Added 5-minute title refresh (`TITLE_POLL_MS`) with deterministic title generation from recent prompts/commands.
- Dashboard now surfaces derived `agentType`, `turnCount`, and generated title in slot cards.

## Milestone 8 (Done): Context Usage Display
Scope:
- Provider-level usage from existing CodexBar integration (`5h`, `weekly`).
- Per-slot context utilization:
  - populate only if hook payload provides reliable fields
  - otherwise show `N/A` explicitly (no fake estimates by default)

Acceptance criteria:
- Dashboard distinguishes provider usage from per-slot usage.
- No misleading inferred per-slot context values.

Status:
- Provider-level usage remains sourced from CodexBar (`5h`, `weekly`) in top usage cards.
- Per-slot `contextWindowPct` is populated only from explicit hook payload fields when present.
- Slot cards now show `Context window: N/A` when no reliable per-slot field is available.

## Milestone 9 (Done): Reliability and Guardrails
Scope:
- Run rotation and bounded retention.
- Robust file writes (atomic metadata updates).
- Graceful behavior when hook writer fails.

Acceptance criteria:
- No runaway storage growth.
- No dashboard breakage from missing/corrupt hook rows.

Status:
- Added slot run rotation with bounded retention (`SLOT_RUN_RETENTION`, default `3`).
- Added atomic JSON writes with unique temp files to avoid state-write races.
- Kept hook execution fail-open (`|| true`) so shell usability is unaffected by hook errors.
- Telemetry parser skips corrupt JSONL rows and keeps dashboard responses stable.

## Fast Feedback Loop
- Use mobile screenshot capture for every visible UI change.

Commands:
- `./dashboard/scripts/start-ttyd-sessions.sh`
- `./dashboard/scripts/start-dashboard.sh`
- `./dashboard/scripts/mobile-screenshot.sh http://127.0.0.1:1111 dashboard/run/dashboard-mobile.png`
