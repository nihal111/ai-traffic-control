# Claude Multi-Account Switching (CLI + Web Usage)

This document explains how Claude account switching works in AI Traffic Control and which commands to run to verify active account + usage.

## What `atc-profile` manages

`dashboard/scripts/atc-profile.mjs` stores one profile per Claude account alias.

For each alias, it captures:
- Claude CLI OAuth credential (from macOS Keychain service `Claude Code-credentials`)
- Claude web `sessionKey` cookie (from Firefox `claude.ai` session)
- Verified account metadata (email/org from Claude OAuth account endpoint)

When switching, it updates:
- active CLI credential
- active codexbar Claude token account (OAuth token preferred; web `sessionKey` fallback)
- active profile marker in `~/.claude-profiles/profiles.json`

## One-command add flow (current behavior)

`add <alias>` is both:
- the primary command for a newly logged-in account
- the refresh command for an existing alias (same email)

After you log in to the target account in both places:
- `claude /login`
- Firefox `claude.ai`

run:

```bash
node dashboard/scripts/atc-profile.mjs add <alias>
```

This single command now:
1. Saves the current Claude CLI credential under `<alias>`.
2. Captures the current Firefox Claude `sessionKey`.
3. Registers the profile and sets it active immediately.
4. Syncs codexbar Claude token account for this alias.

No separate `sync-web` or `use` is required right after `add`.

If `<alias>` already exists and the logged-in email matches, `add` updates that alias in place (rotated CLI creds and fresh web token).
If `<alias>` exists but maps to a different email, `add` refuses to rebind silently.

## Typical setup sequence

```bash
# Account A
claude /login
# (also log into claude.ai in Firefox as account A)
node dashboard/scripts/atc-profile.mjs add primary

# Account B
claude /login
# (also log into claude.ai in Firefox as account B)
node dashboard/scripts/atc-profile.mjs add secondary
```

Use aliases like `primary`, `secondary`, `work`, `personal`, etc.

## Commands to check switching

### 1) Show active + registered profiles

```bash
node dashboard/scripts/atc-profile.mjs list
node dashboard/scripts/atc-profile.mjs current
```

### 2) Switch to an existing profile

```bash
node dashboard/scripts/atc-profile.mjs use secondary
```

`use` swaps CLI creds and validates email match against the saved alias metadata.

### 3) Validate active Claude CLI account directly

```bash
claude auth status --json | jq '{email, organization: (.orgName // .organization)}'
```

## Commands to retrieve usage

### 1) Claude usage via OAuth (recommended; profile-scoped, browser-independent)

```bash
codexbar usage --provider claude --source oauth --format json --pretty
```

### 2) Claude web usage via codexbar (depends on saved `sessionKey` validity)

```bash
codexbar usage --provider claude --source web --format json --pretty
```

### 3) Claude CLI usage via codexbar

```bash
codexbar usage --provider claude --source cli --format json --pretty
```

### 4) Dashboard usage refresh (Claude)

```bash
curl -sS -X POST http://127.0.0.1:1111/api/usage/refresh \
  -H 'Content-Type: application/json' \
  -d '{"provider":"claude","force":true}' | jq
```

## Notes and operational behavior

- Existing running Claude sessions keep their prior auth context; new sessions use the newly active profile.
- If `add` says the credential is identical to another profile, run `claude /login` with the intended account and retry.
- If web usage fails with unauthorized, rerun `add <alias>` while logged into that account in Firefox to refresh the saved `sessionKey`.
- OAuth usage does not depend on Firefox login state and is the default path used by the dashboard now.

## Storage paths

```text
~/.claude-profiles/
├── profiles.json
├── <alias>.cred
└── .backup/
```

Codexbar Claude web auth is synced through:

```text
~/.codexbar/config.json
```
