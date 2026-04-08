# Personal OS V1 Roadmap

This roadmap converts the new product vision into incremental milestones that can be shipped and validated end-to-end.

## Product Goal
Build a browser-native, voice-driven, agent-orchestrated personal operating system where:
- Scientists are persistent execution slots.
- Templates convert intent into deterministic setup.
- Voice is the primary control plane.
- History and second-brain integration provide memory and strategy.

## Guiding Constraints
- Zero-friction startup for common flows: intent to execution in under 10 seconds.
- Keep deterministic slot lifecycle and telemetry foundations already in place.
- Ship thin vertical slices before broad intelligence features.
- Every milestone must leave a user-visible improvement.

## Milestone 0 (Baseline, Already Complete): Stable Runtime + Telemetry
Scope:
- Slot lifecycle, runtime files, shell hooks, Codex/Claude hooks, derived telemetry, retention guardrails.

Outcome:
- Reliable substrate exists for higher-level orchestration.

Status:
- Done.

## Milestone 1: Intent Templates v1 (No Voice Yet)
Theme:
- Replace raw terminal entry with structured spawn flows.

Scope:
- Introduce template menu when activating idle scientist.
- Implement templates:
  - `New Brainstorm`
  - `Continue Work (WIP)`
- For `Continue Work`, add recent projects picker and file explorer fallback.
- Persist template usage and selected context into slot metadata.

Deliverables:
- New UI intent modal for idle scientists.
- Spawn API contract: `scientist + template + provider + workdir`.
- Deterministic defaults for missing selections.

Acceptance criteria:
- Idle click never drops user into unstructured shell by default.
- User can start a brainstorm or continue prior repo without manual shell setup.
- Session metadata includes template selection for replay/analytics.

## Milestone 2: Persona Overlay System
Theme:
- Keep scientist identity stable while role changes are lightweight.

Scope:
- Add persona selector independent of scientist identity.
- v1 personas:
  - `Brainstormer`
  - `Refactorer`
  - `Tester`
  - `Reviewer`
  - `Lucky Dip Explorer`
- Map persona to initial system prompt/instructions at spawn time.

Deliverables:
- Persona registry + UI control.
- Provider-agnostic persona injection at session start.
- Persona shown in slot card and session history.

Acceptance criteria:
- Same scientist can switch persona between runs with one interaction.
- Persona change does not alter slot identity, ports, or historical continuity.

## Milestone 3: Idle Pulse + Stall Detection
Theme:
- Operational awareness for opportunistic delegation.

Scope:
- Add derived state machine per slot:
  - `active`
  - `idle`
  - `stalled`
- Detect inactivity and stalled runs from telemetry thresholds.
- Surface state in dashboard and API.

Deliverables:
- Configurable thresholds for idle/stalled classification.
- Slot pulse indicators and sortable state filters.
- Event annotations when state transitions occur.

Acceptance criteria:
- State transitions are deterministic and explainable from runtime data.
- Dashboard can filter to idle scientists in one interaction.

## Milestone 4: Lucky Dip Suggestions v1
Theme:
- Eliminate blank-canvas moments with actionable re-entry prompts.

Scope:
- Build suggestion engine over recent sessions and unfinished threads.
- Rank candidates by recency, prior momentum, and completion gap.
- Add one-click action from suggestion to template-driven spawn.

Deliverables:
- `Lucky Dip` panel with top 3 suggestions.
- Rationale tags per suggestion (for example `80% complete`, `stale 3d`).
- Launch action that pre-fills scientist, persona, provider, and workdir.

Acceptance criteria:
- User can go from no idea to active session in <= 2 clicks.
- Suggestions are traceable to concrete prior sessions/projects.

## Milestone 5: Voice Control Plane v1
Theme:
- Intent via speech, execution via existing orchestration primitives.

Scope:
- Integrate WhisperFlow transcription pipeline.
- Add intent parser for commands like:
  - `Put Einstein on a new Codex brainstorm`
- Resolve inferred fields with safe defaults and confirmation UX.

Deliverables:
- Voice input capture widget.
- Intent-to-action parser for scientist/template/provider/workdir.
- Confirmation step for low-confidence interpretations.

Acceptance criteria:
- Happy path voice command can spawn correct session without typing.
- Parser confidence and correction actions are logged for tuning.

## Milestone 6: Downtime Prep Automations
Theme:
- Make idle scientists productive without autonomous risk.

Scope:
- Add non-destructive background prep tasks for idle slots:
  - repo health checks
  - test discovery
  - refactor opportunity summaries
  - cleanup suggestions
- Require explicit user approval before any mutating action.

Deliverables:
- Idle queue scheduler with budget and concurrency controls.
- Prep task result cards attached to each scientist.
- One-click `Apply Now` path that spawns proper persona/template.

Acceptance criteria:
- Idle time generates useful, reviewable suggestions.
- No background mutation occurs without explicit user action.

## Milestone 7: Structured History Layer
Theme:
- Upgrade raw logs into queryable memory.

Scope:
- Normalize mapping:
  - `session -> transcript -> project -> scientist -> persona`
- Build timeline API for re-entry by project, date, or scientist.
- Add `Memory Lane` UI for fast context resurrection.

Deliverables:
- Indexed history store (bounded, resilient).
- Session summary cards with deep links to transcript and workspace.
- Memory Lane filters (`recent`, `stalled`, `high-momentum`).

Acceptance criteria:
- User can reopen meaningful prior context in <= 10 seconds.
- History browsing works even when a provider transcript is unavailable.

## Milestone 8: Second Brain Integration v1
Theme:
- Turn execution traces into strategic reflection.

Scope:
- Export structured daily and weekly summaries.
- Add connector for second-brain target (start with Obsidian-compatible markdown output).
- Generate signals:
  - time allocation by project/persona
  - neglected threads
  - suggested next focus

Deliverables:
- Scheduled summary generator.
- Markdown export package with backlinks to sessions/projects.
- Review dashboard: daily brief + weekly review cards.

Acceptance criteria:
- User receives automated daily and weekly summaries with actionable recommendations.
- Summaries include direct re-entry actions, not just passive reporting.

## Milestone 9: V1 End-to-End Quality Gate
Theme:
- Ensure the experience feels magical, not fragile.

Scope:
- Define V1 critical flows and automate tests:
  - idle scientist -> template spawn
  - persona switch
  - voice command spawn
  - lucky dip relaunch
  - memory lane re-entry
- Add UX latency/error SLOs and instrumentation.

Deliverables:
- E2E test suite for V1 flows.
- Reliability dashboard with spawn success rate and median time-to-first-action.
- Launch checklist and rollback plan.

Acceptance criteria:
- Critical-flow pass rate >= 95% in CI.
- Median intent-to-active-session < 10 seconds on local baseline setup.

## Execution Order (Why This Sequence)
1. Templates first to eliminate setup friction with minimal risk.
2. Persona and pulse next to create meaningful orchestration primitives.
3. Lucky Dip before voice so recommendation quality is proven via clicks first.
4. Voice after deterministic intent actions exist.
5. Downtime automation only after stall/idle states are reliable.
6. History and second-brain layers after core execution loop is stable.
7. Final quality gate to lock V1 before expansion.

## Immediate Next Sprint (Recommended)
- Deliver Milestone 1 completely.
- Start Milestone 2 with persona registry and UI only.
- Defer parser and automation complexity until post-template telemetry confirms flow quality.
