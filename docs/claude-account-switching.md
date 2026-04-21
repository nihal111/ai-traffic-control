# Claude Multi-Account Switching (CLI + Web Usage)

This document explains how Claude account switching works in AI Traffic Control, which commands to run, and how the dashboard keeps per-profile credentials from going stale between switches.

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
| Validate identity behind a token | `GET` | `https://api.anthropic.com/api/oauth/account` | Returns `{ email, organizations[] }`. Used by `use` (and the dashboard sync path) to catch the "token is revoked but `expiresAt` still looks fine" case — `claude /status` reads `~/.claude.json` which can be stale. |
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
- The bound codexbar token-account label (e.g. `atc:primary`)

When switching, it updates:
- active CLI credential (Keychain)
- active codexbar Claude token account (OAuth token preferred; web `sessionKey` fallback)
- active profile marker in `~/.claude-profiles/profiles.json`

## Commands at a glance

| Command | What it does |
|---|---|
| `add <alias>` | Register the currently-logged-in Claude account under `<alias>` and set it active. Refreshes the alias in place if it already exists with the same email. Warns before clobbering the previous active profile's unsaved rotated tokens. |
| `rotate <alias>` | Safest way to add or re-register an alias when you still need to preserve the currently-active one: freezes the active profile's keychain state, clears the keychain, guides you through `claude /login`, then registers the new login. Reversible — answering "n" restores the old state. |
| `use <alias>` | Swap to a registered alias. Syncs the outgoing profile's latest keychain tokens back to its `.cred` (identity-verified), proactively refreshes the target if expired, reactively refreshes on 401/403, then swaps the Keychain entry. |
| `list` / `current` | Show registered profiles / active profile. |
| `remove <alias>` | Delete an alias and its saved credential. |
| `sync-web <alias>` | Re-capture just the Firefox `sessionKey` for the alias without swapping. |
| `probe-web` | Diagnose why the Firefox cookie capture failed. |
| `wipe --yes` | Remove every stored profile and clear the Keychain. |

## Registering the first profile: `add`

After you log in to the target account in both places:
- `claude /login`
- Firefox `claude.ai`

run:

```bash
node dashboard/scripts/atc-profile.mjs add <alias>
```

This single command:
1. Reads the current Claude CLI OAuth blob from Keychain.
2. Validates it against `api/oauth/account` and captures the account email + org.
3. Captures the current Firefox Claude `sessionKey`.
4. Registers the profile, sets it active, and syncs the codexbar Claude token account for this alias.

No separate `sync-web` or `use` is required right after `add`.

If `<alias>` already exists and the logged-in email matches, `add` updates that alias in place (rotated CLI creds + fresh web token). If `<alias>` exists but maps to a different email, `add` refuses to rebind silently.

### Drift warning from `add`

If the active profile is `primary@foo.com` and you externally run `claude /logout && claude /login` as `secondary@bar.com`, then invoke `add secondary`, the previously-rotated tokens for `primary` are gone from Keychain — `primary.cred` now points at a revoked refresh token, and the next `use primary` will likely fail with `invalid_grant`. `add` detects this and prompts before proceeding, suggesting `rotate` as the safer flow:

```
⚠  Possible token loss detected.
   Active profile "primary" is bound to primary@foo.com.
   Keychain now holds secondary@bar.com — a different account.
   The rotated tokens for "primary" were NOT saved before the swap.
   Next switch to "primary" may fail; re-login may be required.

   Prefer this safer flow next time:
     atc-profile rotate secondary    # saves current profile, then guides login
```

## Safely adding / re-registering an alias: `rotate`

`rotate <alias>` is the recommended way to log in as a new account (or re-login an existing alias) when you already have an active profile and don't want to risk stranding its refresh token. It owns the entire `logout → login → register` cycle:

```bash
node dashboard/scripts/atc-profile.mjs rotate secondary
```

Flow:
1. **Freeze** — reads the live Keychain, refreshes it if expired, verifies the account identity matches the active profile, and writes the fresh blob to `<active>.cred`. Backs up to `.backup/` first.
2. **Clear** — deletes the Keychain entry so no running `claude` process can rotate the saved refresh token out from under us.
3. **Guide** — prints instructions to close other claude processes and run `claude /login` as the target account, then prompts for confirmation.
4. **Register** — on `y`: reads the new Keychain blob, validates identity via `api/oauth/account`, ensures the email isn't already bound to a different alias, saves `<alias>.cred`, updates `profiles.json`, and syncs codexbar.
5. **Rollback** — on `n`: restores the frozen Keychain blob so the pre-rotate state is preserved intact.

`rotate` is the preferred complement to `use`: `use` moves between already-registered aliases; `rotate` introduces a brand-new login or refreshes an alias whose stored refresh token has gone stale.

## Switching between registered profiles: `use`

```bash
node dashboard/scripts/atc-profile.mjs use <alias>
```

`use` does five things in order:

1. **Sync-active (identity-verified)** — export the live Keychain blob, call `api/oauth/account` to confirm the email matches the currently-active profile's recorded email, and only then write the blob to `<active>.cred`. Opt out with `--no-sync-active` if Keychain password prompts become a problem. If the live access token is expired, `use` refreshes it in place first and writes the rotated pair back to both Keychain and `.cred`.
    - Identity verification is deliberate: email match, not refresh-token equality. Background RT rotations are normal and must not skip the save. An email mismatch means something external swapped the Keychain out from under us, and clobbering the saved cred with the wrong account's tokens would silently destroy the real alias.
2. **Proactive refresh** — if the target blob's `expiresAt` is within 5 minutes, refresh it against `platform.claude.com/v1/oauth/token` and persist the rotated pair back to `<alias>.cred` **before** importing into Keychain. Avoids the stale-snapshot failure where the saved `refreshToken` has already been rotated away by another claude process.
3. **Live validation** — `GET api/oauth/account` with the restored access token, compare returned email against the saved alias email. Catches "token revoked, but `expiresAt` says OK" because `~/.claude.json` is not proof of validity.
4. **Reactive refresh on 401/403** — if the live call rejects the access token (another claude process rotated it away), run one reactive refresh and retry validation. Main self-healing path keeping `use` one-click across snapshot drift.
5. **Swap** — delete Keychain entry, import target blob, update `~/.claude.json` authState, update codexbar active account, bump `catalog.active`.

### Quick status checks

```bash
node dashboard/scripts/atc-profile.mjs list
node dashboard/scripts/atc-profile.mjs current
claude auth status --json | jq '{email, organization: (.orgName // .organization)}'
```

## How the dashboard keeps creds fresh

The dashboard complements `use` / `rotate` by continuously syncing the active profile's Keychain state back to its `.cred` file. Every time the Claude usage poller successfully fetches live data (typically once per `ATC_CLAUDE_USAGE_MIN_INTERVAL_MS`, default 120s), `syncActiveKeychainToCred` in `modules/profile-catalog.mjs` runs:

1. Read the live Keychain blob.
2. Compare its refresh token to the one in `<active>.cred`.
3. If they differ → snapshot the fresh blob to `<active>.cred` (atomic tmp-file + rename).
4. If they match → touch the file's mtime so "last successful sync check" stays current for the UI badge, even when the RT isn't rotating.

This means: by the time you run `atc-profile use <other>`, the outgoing alias's `.cred` is almost always already in lockstep with Keychain. `use`'s own sync-active is a belt-and-suspenders fallback for the case where the dashboard isn't running or hasn't polled recently.

### Staleness badge in the profile card

`/api/profiles` now returns a `credStaleness` field per alias:

```json
{
  "lastSyncAt": "2026-04-21T16:22:34.278Z",
  "lastSyncAgeMs": 44304,
  "credAccessExpiresAt": "2026-04-22T00:22:29.043Z",
  "credAccessExpired": false,
  "stalenessLevel": "fresh"
}
```

Thresholds (in `computeProfileStaleness`):

| Profile state | `fresh` | `warn` | `critical` |
|---|---|---|---|
| Active | ≤5 min since last sync | 5–30 min | >30 min (dashboard likely lost the Keychain read loop) |
| Inactive | ≤3 days since last save | 3–6 days | >6 days (saved RT may age out — Anthropic RT lifetime ~7 days) |

The profile card renders a small badge per card:
- Active: `synced 42s ago` (green) / `⚠ sync lagging — last 8m ago` (yellow) / `⚠ sync stalled — last 42m ago` (red).
- Inactive: `last active 2h ago` (dim) / `last active 4d ago` (yellow) / `⚠ last active 7d ago — re-login likely needed` (red).

An inactive profile in the red band is signalling that you should `use <alias>` soon (which will refresh it in place) or be prepared to `rotate <alias>` if the stored RT has already aged out.

## Getting usage numbers directly

```bash
# OAuth (profile-scoped, browser-independent) — the dashboard default
codexbar usage --provider claude --source oauth --format json --pretty

# Web (depends on saved Firefox sessionKey validity) — fallback
codexbar usage --provider claude --source web --format json --pretty

# CLI fallback (no seven-day window or resets_at)
codexbar usage --provider claude --source cli --format json --pretty

# Force the dashboard to refresh
curl -sS 'http://127.0.0.1:1111/api/usage?provider=claude&force=1' | jq
```

## Notes and operational behavior

- Running Claude sessions will pick up the new account on their next API call — Claude CLI reads credentials from the macOS Keychain entry that `use` swaps, so the switch is effectively immediate. Close long-running sessions before swapping if you want them to stay on the old account.
- If `add` says the credential is identical to another profile, run `claude /login` with the intended account and retry.
- If web usage fails with unauthorized, rerun `add <alias>` while logged into that account in Firefox to refresh the saved `sessionKey`.
- OAuth usage does not depend on Firefox login state and is the default path used by the dashboard.
- The `.backup/` directory keeps time-stamped copies of every frozen Keychain blob, in case a `rotate` or `use` goes wrong and you need to recover a specific snapshot by hand.

## Minimizing the need to re-login

The `.cred` snapshot for an alias can go stale because Claude OAuth refresh tokens are **single-use and rotate**. If another claude process (MCP server, IDE extension, another tmux pane) refreshes while that alias is active in Keychain, the stored refresh token in `<alias>.cred` is revoked server-side. With the current setup, the only realistic failure modes are:

1. The dashboard isn't running while you churn profiles manually via `claude /logout` + `claude /login`. Fix: use `rotate` instead, which owns the logout/login step and never leaves a rotated RT unsaved.
2. A stray `claude` process (e.g. a forgotten tmux pane) is holding the Keychain entry hostage during a switch and rotates the RT between your sync-active and Keychain-swap. Fix: close long-running `claude` processes before `use`, or rely on reactive refresh to self-heal.
3. The saved RT has simply aged out because you haven't used that alias in ~7 days. Fix: `rotate <alias>` and re-login.

Avoiding stale-snapshot pain amounts to: let the dashboard run (it auto-syncs), prefer `rotate` over raw `claude /logout && /login`, and avoid multiple concurrent `claude` processes racing on the same alias.

## Recovering from "invalid credentials" after a switch

If `use` fails with a dead-refresh-token message (`invalid_grant`, `invalid_request`, HTTP 400/401), the saved refresh token for that alias has been invalidated server-side. Recovery:

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
# or (if you still need the currently-active profile preserved):
node dashboard/scripts/atc-profile.mjs rotate <alias>
```

## Environment knobs

| Variable | Default | Applies to |
|---|---|---|
| `ATC_CLAUDE_ACCOUNT_TIMEOUT_SEC` | `8` | `curl --max-time` on the live `api/oauth/account` identity check. |
| `ATC_CLAUDE_REFRESH_TIMEOUT_SEC` | `15` | `curl --max-time` on `platform.claude.com/v1/oauth/token` refresh calls. |
| `ATC_CLAUDE_USAGE_MIN_INTERVAL_MS` | `120000` | Dashboard per-profile throttle between live Claude usage fetches. |
| `ATC_CLAUDE_CODEXBAR_TIMEOUT_MS` | `25000` | Dashboard timeout when shelling out to `codexbar usage --provider claude`. |
| `ATC_CLAUDE_STATUS_TIMEOUT_MS` | `25000` | Dashboard timeout when calling `claude status` for the CLI-fallback parser. |

## Storage paths

```text
~/.claude-profiles/
├── profiles.json        # catalog: { version, active, profiles: { <alias>: { email, authState, webAuth, codexbarToken, usageCache, … } } }
├── <alias>.cred         # mode 0600 — JSON blob { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType } }
└── .backup/             # time-stamped snapshots taken before destructive ops (rotate, sync-active, add-when-overwriting)
```

Codexbar Claude token accounts are synced through:

```text
~/.codexbar/config.json  # providers[claude].tokenAccounts.accounts[] keyed by label (atc:<alias>)
```
