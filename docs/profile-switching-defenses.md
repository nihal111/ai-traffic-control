# Profile switching: why the "won't switch" error cannot happen again

## Read this first

You opened this because either (a) you want to understand what protects
profile switching from breaking, or (b) profile switching just broke and you
need to debug it. Jump to the relevant section:

- **Debug right now:** [§ Triage playbook](#triage-playbook)
- **Understand the defenses:** [§ The four failure modes and what blocks each](#the-four-failure-modes-and-what-blocks-each)
- **What each log event means:** [§ Event field glossary](#event-field-glossary)

## The problem, one paragraph

Profile switching on the dashboard repeatedly broke with a generic "Access
token rejected" message. The actual causes stacked across days and were
different each time:

1. A race between `atc-profile rotate` and the dashboard's sync-daemon wrote
   a freshly-logged-in account's refresh token into the *other* alias's
   `.cred` file, contaminating it.
2. The silent RT rotations that Claude Code performs in the background then
   consumed those contaminated tokens against the wrong account.
3. We tried to mitigate by refreshing OAuth tokens ourselves
   (`POST platform.claude.com/v1/oauth/token`). Anthropic's edge fingerprints
   the request shape; tokens minted by our refresh path landed in a degraded
   attribution bucket and were already rate-limited at the moment they
   reached the keychain.

The fixes landed in commits 1fb9825 (rotate/sync race), 3fa858e (trace IDs),
81b30a7 (UUID pinning), and the refactor that removed self-refresh entirely
in favor of letting Claude Code handle every `/v1/oauth/token` call. This
doc explains what each defense prevents and how to tell — from the log —
which one fired if something goes wrong again.

## The four failure modes and what blocks each

### 1. Sync-daemon writes wrong account's creds into a `.cred` file

**How it used to fail:** `atc-profile rotate primary` clears the keychain and
waits for the user to run `claude /login`. During that window, the
sync-daemon saw keychain state that didn't match `<active>.cred` and wrote
the new login into the *outgoing* alias's file.

**Defenses (in order of how early they catch it):**

1. **Rotate lock** (`profile-catalog.mjs:isRotateLockStale`). Rotate sets
   `profiles.json.rotation = { inProgress:true, rotateId, ... }` before
   touching the keychain. Sync-daemon checks this first and emits
   `sync-skip outcome=skipped:rotate-lock`. Stale locks (>30min) fall
   through with `rotate-lock-stale` logged — hung rotate doesn't paralyze
   the daemon forever.
2. **UUID pin check** (`profile-catalog.mjs` identity block). Even if the
   rotate lock somehow failed to set, the sync-daemon now calls
   `api/oauth/account` on the keychain blob and verifies the returned
   account UUID matches the alias's pinned UUID. UUID mismatch → emits
   `identity-pin-broken` + `sync-skip outcome=skipped:uuid-mismatch`, no
   write happens.
3. **Email fallback check** (only for profiles without a UUID pin).

**What you'll see if this recurs:**

```
{"action":"identity-pin-broken","alias":"secondary","pinned_uuid":"11...",
 "observed_uuid":"22...","outcome":"sync-aborted"}
{"action":"sync-skip","outcome":"skipped:uuid-mismatch",...}
```

The daemon aborts and logs the attempted contamination. No disk or keychain
write occurs. **This is the expected behavior** — it means the defense is
working. If you ever see `identity-pin-broken` you know something tried to
contaminate a cred file and was stopped.

### 2. Switch loads a `.cred` for the wrong account

**How it used to fail:** If contamination somehow slipped past the
sync-daemon, a later `atc-profile use primary` would load `primary.cred`,
make an OAuth call, and proceed if the email happened to match. Emails can
be re-used across accounts (rare, but possible) — this was a soft gate.

**Defenses:**

- **Byte-level email guard** (`switchProfile`, before any I/O). Compare the
  email embedded in `<alias>.cred` against the alias's bound email. Mismatch
  → die with `blob-identity-mismatch` before touching the keychain or
  reaching the network.
- **UUID pin** (`switchProfile`, after `/account` returns). Compare the live
  `accountUuid` against `profile.accountUuid`. If the pin exists and
  doesn't match, die with `target-uuid-mismatch`. Logged as:

```
{"actor":"switch","action":"identity-pin-broken",
 "pinned_uuid":"...","observed_uuid":"...","outcome":"switch-abort"}
{"actor":"switch","action":"switch-abort","outcome":"target-uuid-mismatch"}
```

UUIDs are server-assigned and per-account. An attacker cannot forge them,
and Anthropic does not re-issue them. A pin mismatch is ironclad proof of
contamination.

If the access token in `<alias>.cred` is stale (Claude Code rotated past
it), the live `/account` call returns 401/403. We log
`identity-check outcome=stale-at-fallthrough`, skip the live UUID gate, and
trust the byte-level email guard plus the cached UUID pin (set at
registration time). Claude Code refreshes on its next API call.

### 3. Claude Code silently rotates an RT while we hold a stale `.cred`

**How it used to fail:** Claude Code's own runtime refreshes RTs in the
background and writes the new token into the keychain. If `.cred` held an
older RT, next switch-back would try to use a dead token.

**Defense:** The sync-daemon's job is exactly this — keep `<active>.cred` in
lockstep with keychain rotations. It runs every 10s (safety poll) plus
triggered on `~/.claude.json` changes (watcher). On successful sync, emits:

```
{"action":"sync-write","alias":"primary","prev_rt_fp":"...A","rt_fp":"...B",
 "outcome":"ok","trigger":"safety-poll"}
```

The UUID pin means this write only happens after the keychain identity is
verified. So the daemon has *two* safety checks active on every write: the
rotate lock, AND the UUID match.

We deliberately do not call Anthropic's `/v1/oauth/token` from the
dashboard at all. Claude Code is the only client allowed to mint tokens —
its requests come from an allowlisted client fingerprint. Our previous
attempts to refresh ourselves succeeded (HTTP 200) but produced tokens
bound to a degraded attribution bucket at Anthropic's edge, which surfaced
as immediate rate-limit errors. Letting Claude Code handle every refresh
removes that whole class of failure.

### 4. Ambiguity: "which operation failed and why?"

**How it used to fail:** Forensic analysis required manually correlating
events by alias + timestamp proximity. When multiple operations overlapped
(CLI rotate while dashboard switch is in flight), untangling them was hard.

**Defense:** Trace IDs. Every credential-touching operation generates a
UUID at entry and emits it as `trace_id` on every event it produces.
`recordEvent` auto-promotes `switch_id`, `rotate_id`, and `add_id` to
`trace_id` so no caller needs to pass it explicitly. A single command
reassembles the whole operation:

```
atc-profile diagnose <trace-id>
```

Output:

```
Trace e1906c1d-3541-411e-8209-9cf7a8b9077f — 5 events:

+    0ms [switch] switch-start alias=primary outcome=started
+    1ms [switch] disk-read alias=primary rt=...QqaAAA outcome=ok
+   95ms [switch] identity-check alias=primary outcome=match
+   96ms [switch] sync-write alias=secondary outcome=ok
+   97ms [switch] switch-complete alias=primary outcome=ok
```

## Triage playbook

If profile switching breaks, follow this in order. Each step makes a
specific failure visible in one command.

### 0. What account is the dashboard pointing at, and is it pinned?

```bash
cat ~/.claude-profiles/profiles.json | jq '.profiles | to_entries |
  map({alias:.key, email:.value.email, uuid:.value.accountUuid,
       pinnedAt:.value.accountUuidPinnedAt})'
```

If `uuid` is `null` for any alias, UUID pinning is not active for that
profile. Running `atc-profile use <alias>` on a healthy AT backfills it.

### 1. Did recent switches fail with contamination?

```bash
tail -500 ~/Code/AiTrafficControl/dashboard/runtime/logs/credential-events.jsonl |
  jq -c 'select(.action == "identity-pin-broken" or
                (.action | startswith("switch-abort")))'
```

If you see `identity-pin-broken`: **the defense fired**. The creds were
prevented from being written — look at the emitted `pinned_uuid` vs
`observed_uuid` to understand what tried to happen. Then:
- If the pinned UUID is correct (the one you expect for that alias), the
  *attempt* was wrong — something tried to write a different account into
  that alias's file. Investigate what ran (check `actor` field and nearby
  events).
- If the pinned UUID is wrong, a past contamination set the pin to the
  wrong account. Run `atc-profile remove <alias>` + fresh login.

### 2. What's the full story of one failed operation?

Find the `trace_id` from the failing switch (any event at the failure
time will have it):

```bash
grep "switch-abort" ~/Code/AiTrafficControl/dashboard/runtime/logs/credential-events.jsonl |
  tail -5 | jq -r '.trace_id'
```

Then:

```bash
node ~/Code/AiTrafficControl/dashboard/scripts/atc-profile.mjs diagnose <trace-id>
```

This prints every event in that operation in chronological order with
delta-millis timestamps. No jq needed.

### 3. Is the sync-daemon healthy?

The daemon is the last line of defense. If it's broken, new RT rotations
won't land in `.cred` files and future switches will fail with dead tokens.

```bash
tail -20 ~/Code/AiTrafficControl/dashboard/runtime/logs/credential-events.jsonl |
  jq -c 'select(.actor == "sync-daemon")'
```

Expected steady state: `sync-check outcome=unchanged` every ~10s. If you see
`skipped:rotate-lock` persisting more than a minute, a rotate is hung —
inspect `profiles.json.rotation` and consider manually clearing it only if
you're certain no active `atc-profile rotate` is in progress.

## Event field glossary

Fields that appear in `credential-events.jsonl`. Most events have a subset.

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 UTC timestamp |
| `pid` | Process ID (lets you correlate events from the same CLI invocation) |
| `actor` | Who emitted: `sync-daemon`, `switch`, `rotate`, `add`, `atc-profile` |
| `action` | What happened: `sync-check`, `switch-start`, `identity-check`, `identity-pin-broken`, etc. |
| `alias` | Profile alias this event concerns (may be null for global events) |
| `outcome` | Result: `ok`, `unchanged`, `skipped:<reason>`, `error:<type>`, `match`, `mismatch`, etc. |
| `trace_id` | UUID correlating every event in one logical operation. **Always use this to group events.** |
| `switch_id` / `rotate_id` / `add_id` | Operation-specific IDs (also promoted to `trace_id`) |
| `rt_fp` / `at_fp` | Token fingerprints (`...LAST6`) — never raw tokens |
| `pinned_uuid` / `observed_uuid` | Account UUIDs for identity checks |
| `expected_email` / `observed_email` | Soft identity check values |
| `trigger` | Sync-daemon trigger: `safety-poll`, `fs-watch`, `usage-poll`, `startup` |
| `http_status` | HTTP response status for `/account` identity calls |
| `reason` | Free-text context: why a write happened, what phase we're in |

## Events that should cause alarm

Seeing any of these in fresh log lines means something non-trivial is
happening. In order of severity:

- **`identity-pin-broken`** — UUID mismatch detected. The defense fired and
  blocked a write. Something tried to contaminate a `.cred`. Investigate the
  surrounding events in the same `trace_id`.
- **`skipped:uuid-mismatch` / `skipped:uuid-unverified`** — sync-daemon
  refused to write because the keychain identity didn't match the pinned
  UUID (or couldn't be verified via `/account`).
- **`target-uuid-mismatch` / `target-identity-mismatch` / `blob-identity-mismatch`**
  — switch pre-flight caught the contamination before touching the keychain.
- **`sync-skip outcome=skipped:rotate-lock`** for more than a minute —
  probably a hung rotate. Check `profiles.json.rotation`.

Events that are normal and expected:

- `sync-check outcome=unchanged` every ~10s (daemon heartbeat, healthy).
- `rt-rotation` pairs showing `prev_rt_fp → new_rt_fp` (silent RT rotations
  by Claude Code are normal; what matters is that the new one got written
  to the right `.cred`).
- `identity-check outcome=stale-at-fallthrough` on switch — target's AT
  expired between syncs, byte-level guards still apply, Claude Code will
  refresh on its next call.

## Configuration knobs

| Variable | Default | Purpose |
|---|---|---|
| `ATC_CLAUDE_ACCOUNT_TIMEOUT_SEC` | 8 | `curl --max-time` on the live `api/oauth/account` identity check |
| `ATC_CREDENTIAL_SAFETY_POLL_MS` | 10000 (10s) | Sync-daemon safety poll interval |

## Appendix: the defenses, visually

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  user: atc-profile use primary                                       │
  │  (dashboard: POST /api/profiles/switch { alias:"primary" })          │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 1: load <alias>.cred  │──── missing ──► error
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 2: blob email matches │──── mismatch ──► abort
                │  alias.email (byte-level)   │   (blob-identity-mismatch)
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 3: /account live call │
                │  fetch { email, uuid }      │──── 401/403 ──► skip live
                │                             │   gate (stale AT)
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 4: UUID matches pin?  │──── mismatch ──► abort
                │  (hard gate when live)      │   (identity-pin-broken
                └────────────┬───────────────┘    + target-uuid-mismatch)
                             │ match
                ┌────────────▼───────────────┐
                │  Gate 5: email matches?     │──── mismatch ──► abort
                │  (soft, for legacy profiles)│
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Sync-active: freeze         │
                │  current keychain →          │
                │  <previous-alias>.cred       │── same UUID/email checks ──►
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Keychain swap               │
                │  clear → import(new)         │
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Write catalog, emit         │
                │  switch-complete event       │
                └─────────────────────────────┘
```

Every gate emits a structured event on failure. The `trace_id` on every
event lets `atc-profile diagnose <id>` reconstruct which gate stopped you.
