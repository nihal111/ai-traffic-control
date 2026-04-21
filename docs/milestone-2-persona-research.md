# Milestone 2 Research: Persona Agents Across Codex, Claude, Gemini

Date: 2026-04-07
Scope: Research-only notes to guide implementation of Milestone 2 (Persona Overlay System).

## 1) Problem statement

We want persona-based "custom agents" for scientist sessions:
- Brainstormer
- Refactor
- Tester
- Reviewer
- Slot Machine Bandit

Constraints from product direction:
- Persona selectable only at session start (not mutable for active sessions).
- Default should be vanilla (no persona/hat) rather than Brainstormer.
- Persona guidance should live in markdown files, with provider-native mechanism preferred over ad-hoc inline prompt injection.

## 2) Provider capability research

### 2.1 Codex

Observed locally via CLI help:
- `codex --profile <name>` exists.
- Config overrides via `--config key=value`.

Official docs indicate:
- Codex supports layered project instructions via `AGENTS.md` and overrides.
  - https://developers.openai.com/codex/guides/agents-md
- Codex supports Skills (`SKILL.md`) with discovery across `.agents/skills` and user/global locations.
  - https://developers.openai.com/codex/skills
- Codex supports custom subagents using TOML files under `.codex/agents/*.toml` plus `[agents]` config.
  - https://developers.openai.com/codex/subagents
  - Required fields include `name`, `description`, `developer_instructions`.

Key fit for our use case:
- For "start session as persona", `--profile` is simple if profile maps cleanly to persona.
- Skills/subagents are more powerful but may require explicit invocation semantics depending on workflow.

### 2.2 Claude Code

Observed locally via CLI help:
- `--agent <agent>`
- `--agents <json>`
- `claude agents` command

Official docs indicate:
- Custom subagents are first-class and can be defined in `.claude/agents/` or `~/.claude/agents/`.
- Session-wide persona behavior can be forced with `--agent`.
- Ephemeral per-session custom agents can be injected with `--agents '{...}'` JSON.
  - https://docs.anthropic.com/en/docs/claude-code/sub-agents

Key fit for our use case:
- Best native support for explicit "start this run with persona X" via `--agent`.
- Can keep persona specs as files in repo (`.claude/agents/*.md`) and just pass selected agent name on spawn.

### 2.3 Gemini CLI

Observed locally via CLI help:
- No direct `--agent <name>` flag in top-level help.
- `gemini skills ...` management exists.

Official docs indicate:
- Skills are first-class (`SKILL.md`, install/link/list/enable/disable).
  - https://geminicli.com/docs/cli/skills/
- `GEMINI.md` is hierarchical project context for persistent guidance.
  - https://geminicli.com/docs/cli/gemini-md/
- Subagents exist as an experimental feature under `.gemini/agents/*.md` with `experimental.enableAgents=true`.
  - https://geminicli.com/docs/core/subagents/
- Remote subagents (A2A) also exist as experimental.
  - https://geminicli.com/docs/core/remote-agents/

Key fit for our use case:
- Viable native path exists through experimental subagents.
- Skills + GEMINI.md are stable alternatives if we avoid experimental features.

## 3) Cross-provider implementation options

### Option A: Provider-native agents only

- Codex: `.codex/agents/*.toml` + explicit subagent workflow/profile mapping.
- Claude: `.claude/agents/*.md` + `--agent` at spawn.
- Gemini: `.gemini/agents/*.md` (experimental) + enable agent feature.

Pros:
- Maximum fidelity with each provider.
- Better long-term extensibility.

Cons:
- Uneven maturity across providers (Gemini experimental).
- More moving parts to maintain.

### Option B: Universal persona markdown + startup message injection

- Keep single source persona markdown in repo.
- On spawn, send provider-specific "initial instruction" text as first turn.

Pros:
- Cross-provider consistency.
- Simpler immediate rollout.

Cons:
- Less native than provider agent systems.
- Session behavior depends on first-turn prompt discipline.

### Option C (Recommended): Hybrid

- Canonical persona markdown files in repo as source of truth.
- Provider adapters generated/maintained alongside:
  - Claude: native agent files + `--agent`.
  - Gemini: start with stable Skills/GEMINI.md path; evaluate subagents after feature-flag hardening.
  - Codex: start with profile+instructions file mapping; graduate to custom subagents when orchestration is needed.
- Dashboard API passes `personaId` now; provider launch command resolves to best available native mechanism.

Why this is recommended:
- Delivers Milestone 2 plumbing without blocking on experimental parity.
- Preserves ability to move each provider to native agents incrementally.

## 4) Prompt/source research (seed material)

Primary practical prompt resources discovered:
- Awesome Reviewers (large corpus of code-review prompts distilled from OSS review comments)
  - https://github.com/baz-scm/awesome-reviewers
- Awesome Claude Agents (community index of Claude subagent patterns)
  - https://github.com/rahulvrane/awesome-claude-agents
- Awesome Cursor Rules (large set of rule/prompt files for coding workflows)
  - https://github.com/PatrickJS/awesome-cursorrules
- GitHub official prompt-file example for code review
  - https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/review-code

Curation guidance for our persona files:
- Treat community prompt repos as inspiration, not drop-in truth.
- Prefer concise, testable instructions over long style essays.
- Add explicit "definition of done" and "anti-goals" per persona.
- Keep references to named thinkers (e.g., Fowler/Beck) as principles, not imitation roleplay.

## 5) Proposed repository structure (updated)

- `personas/` at repo root (canonical source, outside dashboard)
  - `brainstormer.md`
  - `refactor.md`
  - `tester.md`
  - `reviewer.md`
  - `slot-machine-bandit.md`
- `personas/providers/claude/.claude/agents/*.md` (optional adapter artifacts)
- `personas/providers/codex/` (optional profile + config adapters)
- `personas/providers/gemini/` (optional skills/agent adapters)

## 5.1) Simplest viable path (prompt-file-first)

If we only need startup guidance (no custom tools/MCP), we can avoid full agent definitions initially.

- Keep persona text in markdown files under `personas/`.
- At spawn time, load the selected markdown file and pass it as initial prompt context via provider CLI.
- Keep provider-native agent files optional for phase 2.

This is the lowest-friction implementation and still keeps canonical persona content reusable.

## 6) Immediate engineering implications for Milestone 2

1. Add `personaId` to dashboard spawn API and persisted session metadata.
2. Keep default `personaId = none` (vanilla mode).
3. Extend provider launch command generation to optionally include persona adapter args.
4. Show persona badge on session card.
5. Add intent-modal persona selector (start-time only).
6. Enforce immutability for active session persona (change requires respawn).

## 7) Open decisions

1. Rename "Lucky Dip Explorer" persona.
2. Whether Gemini path should start with experimental subagents now, or stable skills/context first.
3. Whether Codex path should launch with profile-based mapping first, then custom subagents in phase 2.

## 8) Suggested rename candidates for "Lucky Dip Explorer"

Decision: use `Slot Machine Bandit`.

## 9) Source harvesting plan for persona content

High-signal sources for seed content (research completed):

1. Awesome Reviewers:
   - Repo: https://github.com/baz-scm/awesome-reviewers
   - Relevant content folders documented in repo: `_reviewers/`, `_skills/`
   - Useful for `Reviewer` and parts of `Tester`/`Refactor` quality checklists.

2. Awesome Claude Agents:
   - Repo: https://github.com/rahulvrane/awesome-claude-agents
   - Contains concrete `.claude/agents/*.md` examples and invocation patterns.
   - Useful for structure and trigger wording.

3. Awesome Cursor Rules:
   - Repo: https://github.com/PatrickJS/awesome-cursorrules
   - Broad rules corpus including testing-focused rule packs.
   - Useful for practical, concise constraints.

4. GitHub prompt files reference:
   - Doc: https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/review-code
   - Useful as a high-quality baseline structure (role, review areas, output contract).
