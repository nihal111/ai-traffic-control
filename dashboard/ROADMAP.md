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

## Milestone 3 (Next): Shell-Level Hooks (Required Before Agent Hooks)
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

## Milestone 4: Shared Hook Writer + Env Contract
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

## Milestone 5: Codex Native Hooks Integration
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

## Milestone 6: Claude Native Hooks Integration
Scope:
- Configure Claude hooks to call the same shared hook writer.
- Normalize Claude hook payload into the same event schema as Codex.

Acceptance criteria:
- Claude events appear in slot `events.jsonl` with `provider=claude`.
- Dashboard shows Claude-specific activity only when Claude events exist.

## Milestone 7: Derived Metrics + Title Generation
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

## Milestone 8: Context Usage Display
Scope:
- Provider-level usage from existing CodexBar integration (`5h`, `weekly`).
- Per-slot context utilization:
  - populate only if hook payload provides reliable fields
  - otherwise show `N/A` explicitly (no fake estimates by default)

Acceptance criteria:
- Dashboard distinguishes provider usage from per-slot usage.
- No misleading inferred per-slot context values.

## Milestone 9: Reliability and Guardrails
Scope:
- Run rotation and bounded retention.
- Robust file writes (atomic metadata updates).
- Graceful behavior when hook writer fails.

Acceptance criteria:
- No runaway storage growth.
- No dashboard breakage from missing/corrupt hook rows.

## Fast Feedback Loop
- Use mobile screenshot capture for every visible UI change.

Commands:
- `./dashboard/scripts/start-ttyd-sessions.sh`
- `./dashboard/scripts/start-dashboard.sh`
- `./dashboard/scripts/mobile-screenshot.sh http://127.0.0.1:1111 dashboard/run/dashboard-mobile.png`
