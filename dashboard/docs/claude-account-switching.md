# Claude Multi-Account Switching (CLI + Web Usage)

This document explains how Claude account switching works in AI Traffic Control and which commands to run to verify active account + usage.

## Background: credentials, Keychain, and OAuth

Before jumping into the switching flow, it's useful to have a mental model of where Claude credentials live and how they get rotated. The Claude CLI itself is not open source, but a community-maintained reverse-engineered copy at [`yasasbanukaofficial/claude-code`](https://github.com/yasasbanukaofficial/claude-code) documents the behavior this tool has to interoperate with; references below point at that mirror.

### Two unrelated credential types for the same account

A single Claude account ends up with two independent authenticators that unlock two different surfaces:

1. **CLI OAuth credential** — issued by `claude /login`, used by the `claude` binary, IDE extensions, MCP servers, and anything that hits `api.anthropic.com` on behalf of the user. On macOS, it's stored in the system Keychain under the service name `Claude Code-credentials` as a JSON blob: `{ accessToken, refreshToken, expiresAt, scopes, subscriptionType }`.
2. **Web `sessionKey` cookie** — issued by the ordinary browser sign-in at `claude.ai`, used by `claude.ai` itself to render the chat UI and answer the legacy per-session usage endpoints. On this machine it's read out of Firefox's `cookies.sqlite` database for the `claude.ai` domain.

These are **not interchangeable**. A valid `sessionKey` does not grant CLI access, and a valid OAuth access token does not authenticate the claude.ai web UI. `atc-profile` captures both per alias so a switch can restore CLI usage, web usage lookups, *and* the codexbar proxy's account binding in one shot.

### What "Keychain" actually is

On macOS, the Keychain is a per-user encrypted credential store managed by `securityd`. Processes identify themselves (by code-signing identity and ACL) when reading/writing entries. `security add-generic-password` / `security find-generic-password` are the command-line interface. Claude CLI reads its OAuth blob from the `Claude Code-credentials` service there; when we "swap" an account, we literally overwrite that single entry with the blob saved for the target alias. The CLI checks the Keychain on every API call, so a swap is effectively immediate — no restart required (confirmed by [`invalidateOAuthCacheIfDiskChanged`](https://github.com/yasasbanukaofficial/claude-code) in the reverse-engineered source, which invalidates the in-memory cache when the Keychain entry changes under the CLI's feet).

### What "OAuth" means here

Claude uses the standard OAuth 2.0 **authorization-code flow with PKCE**, with one important wrinkle: **refresh tokens are single-use and rotate on every refresh**. Every refresh call returns a brand-new `access_token` *and* a brand-new `refresh_token`, and the old refresh token is revoked server-side the instant the new pair is issued.

The pieces:
- `access_token`: bearer token, ~1h lifetime, sent as `Authorization: Bearer …` on every API request.
- `refresh_token`: opaque, long-lived, exchanged at the token endpoint for a new pair when the access token is near expiry. Single-use — using it invalidates it.
- `expiresAt`: absolute ms timestamp when the CLI will proactively refresh. Upstream uses a 5-minute skew (refresh if `Date.now() + 5min > expiresAt`), and so do we.
- `scopes`: space-separated list of capabilities. The CLI requests `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`, and we pass the same string back on refresh so the new access token inherits them.

### Endpoints this tool talks to

| Purpose | Method | URL | Notes |
|---|---|---|---|
| Refresh access/refresh token pair | `POST` | `https://platform.claude.com/v1/oauth/token` | Body: `grant_type=refresh_token`, `refresh_token`, `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `scope`. Matches upstream constants in [`src/constants/oauth.ts`](https://github.com/yasasbanukaofficial/claude-code/blob/main/src/constants/oauth.ts). |
| Validate identity behind a token | `GET` | `https://api.anthropic.com/api/oauth/account` | Returns `{ email, organizations[] }`. Used by `use` to catch the "token is revoked but `expiresAt` still looks fine" case — `claude /status` reads `~/.claude.json` which can be stale. |
| Read rolling usage windows | `GET` | `https://api.anthropic.com/api/oauth/usage` | Returns five-hour + seven-day utilization with `resets_at`. The dashboard reads this via codexbar's `--source oauth` path. |

### Throttling constraints to be aware of

- **Refresh endpoint rate limit**: Repeated calls against the same refresh-token lineage can return `429 rate_limit_error`. There's no `Retry-After` header; community reports converge on **~15 minute recovery**. If `use` fails with `invalid_grant` *and* you've been refresh-storming (e.g., many claude processes starting simultaneously after a reboot), the fix is to wait 15 minutes and re-login, not retry harder.
- **Dashboard per-provider throttle**: `fetchClaudeUsageRateLimited` in `modules/provider-usage.mjs` enforces `ATC_CLAUDE_USAGE_MIN_INTERVAL_MS` (default 120s) between live fetches; within that window it returns the last cached value with `throttled: true`. After a profile switch we bypass this with `{ force: true }` so the card doesn't render the outgoing account's cached windows.
- **Cache-drift failure mode**: If two independent `claude` processes are alive against the same Keychain entry, they race on refresh. The first to rotate wins; the second finds its in-memory refresh token revoked. This is the usual cause of mid-session `invalid_grant` errors — see "Recovering from invalid credentials" below.

### Why `codexbar --source oauth` beats `claude --source cli` for dashboard usage

The dashboard has three ways to pull usage numbers; they are not equivalent:

1. **`codexbar --source oauth`** (default in the dashboard): reads the CLI Keychain OAuth token, hits `api.anthropic.com/api/oauth/usage` directly. Profile-scoped (it follows whichever account is currently in Keychain), browser-independent, returns both five-hour *and* seven-day utilization with real `resets_at` timestamps. This is the path the card actually renders.
2. **`codexbar --source web`**: uses the saved Firefox `sessionKey` to hit claude.ai's internal endpoints. Works, but depends on Firefox login state — if you log out of claude.ai in Firefox, this silently breaks until the next `add`. Used as fallback.
3. **`codexbar --source cli` / `claude /status`**: shells out to the `claude` binary. Reports five-hour `usedPercent` but does not include the seven-day window or any `resets_at` value, so the card ends up with a perpetually-missing reset time. Used only as last-resort fallback.

The OAuth path is the load-bearing default because it's the only one that's (a) source-of-truth (same endpoint claude.ai itself uses), (b) doesn't require a live browser session, and (c) returns the full window metadata the UI needs to show "resets in X".

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

On `use`, atc-profile will:

1. Back up the currently-active profile's rotated tokens to its `.cred` file
   (opt out with `--no-sync-active` if Keychain password prompts are a problem).
2. If the target profile's saved access token is expired or within 2 minutes of
   expiry, POST to `https://console.anthropic.com/v1/oauth/token` with the saved
   refresh token to mint a fresh pair, and persist the rotated pair back to
   `<alias>.cred` **before** importing into Keychain. This avoids the "stale
   snapshot" failure where the saved `refreshToken` has already been rotated
   away by another claude process.
3. Make a live `GET api/oauth/account` request with the restored access token
   and compare the returned email against the saved alias email. This catches
   cases where `/status` shows the right email but the underlying token is
   actually revoked — identity in `~/.claude.json` is not proof of validity.
4. If that live call returns 401/403 (access token dead despite `expiresAt`
   looking valid — another claude process rotated our token away), attempt
   one reactive refresh and retry the validation. This is the main
   self-healing path that keeps `use` one-click across snapshot drift.
5. Swap the Keychain entry and update the active-profile marker.

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

- Running Claude sessions will pick up the new account on their next API call — Claude CLI reads credentials from the macOS Keychain entry that `use` swaps, so the switch is effectively immediate. Close long-running sessions before swapping if you want them to stay on the old account.
- If `add` says the credential is identical to another profile, run `claude /login` with the intended account and retry.
- If web usage fails with unauthorized, rerun `add <alias>` while logged into that account in Firefox to refresh the saved `sessionKey`.
- OAuth usage does not depend on Firefox login state and is the default path used by the dashboard now.

## Minimizing the need to re-login

The `.cred` snapshot for an alias can go stale because Claude OAuth refresh tokens are **single-use and rotate**. If another claude process (MCP server, IDE extension, another tmux pane) refreshes while that alias is active in Keychain, the stored refresh token in `<alias>.cred` is revoked server-side. `use` is resilient to this up to a point:

1. **Sync-on-switch-away** (default): `use` first snapshots the current Keychain tokens back to the outgoing alias's `.cred`, capturing whatever rotations happened while it was active.
2. **Proactive refresh**: if the target blob's `expiresAt` is within 2 minutes, `use` refreshes before the Keychain swap and writes the rotated pair back to `.cred`.
3. **Reactive refresh**: if live validation against `api/oauth/account` returns 401/403 (access token dead despite `expiresAt` looking fine — the drift case), `use` attempts one refresh and retries validation.

To maximize the chance that `use <alias>` "just works" with no re-login:

- Avoid running multiple claude processes concurrently against different aliases. One background process silently rotating tokens for the non-active alias is the usual cause of drift.
- Don't spam the refresh endpoint. Repeated failed refreshes can rate-limit (429) the refresh token for ~15 minutes.
- When you only have one machine and one set of aliases, the expected flow is: one-time `add` per alias, then `use <alias>` indefinitely. Re-login is only needed when the refresh token itself is revoked (e.g., rate-limit storm, or Anthropic-side invalidation).

## Recovering from "invalid credentials" after a switch

If `use` fails with a dead-refresh-token message (`invalid_grant`, `invalid_request`,
HTTP 400/401), the saved refresh token for that alias has been invalidated server-side.
Claude OAuth refresh tokens are **single-use and rotate** on every refresh, so this
happens when another `claude` process (another tmux pane, MCP server, IDE extension)
refreshed the token between the last `atc-profile add` and now, leaving the stored
snapshot pointing at a revoked refresh token.

To recover:

```bash
# 1. Log the CLI out and kill any other running claude processes so they
#    don't race on the new token.
claude /logout

# 2. Make sure the CLI itself is current — Keychain ACLs can break across
#    auto-updates and produce the same symptom.
claude update

# 3. Restart your shell so in-memory token caches are cleared, then re-auth.
exec $SHELL -l
claude /login

# 4. Re-register the alias with the freshly rotated pair.
node dashboard/scripts/atc-profile.mjs add <alias>
```

## Environment knobs

- `ATC_CLAUDE_ACCOUNT_TIMEOUT_SEC` (default `8`) — timeout for the live
  `api/oauth/account` validation call.
- `ATC_CLAUDE_REFRESH_TIMEOUT_SEC` (default `15`) — timeout for the
  `console.anthropic.com/v1/oauth/token` refresh call.

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
