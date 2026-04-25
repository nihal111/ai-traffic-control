# Profile switching: why the "won't switch" error cannot happen again

## Read this first

You opened this because either (a) you want to understand what protects
profile switching from breaking, or (b) profile switching just broke and you
need to debug it. Jump to the relevant section:

- **Debug right now:** [§ Triage playbook](#triage-playbook)
- **Understand the defenses:** [§ The five failure modes and what blocks each](#the-five-failure-modes-and-what-blocks-each)
- **What each log event means:** [§ Event field glossary](#event-field-glossary)

## The problem, one paragraph

Profile switching on the dashboard repeatedly broke with a generic "Access
token rejected" message. The actual causes stacked across days and were
different each time:

1. A race between `atc-profile rotate` and the dashboard's sync-daemon wrote
   a freshly-logged-in account's refresh token into the *other* alias's
   `.cred` file, contaminating it.
2. The silent RT rotations that Claude Code performs in the background then
   consumed those contaminated tokens against the wrong account, charging
   the wrong account's refresh-rate counter at Anthropic.
3. Once Anthropic flagged the account, every subsequent refresh (even with a
   brand-new RT from a fresh login) came back HTTP 429, and the error
   surfaced as a generic "Access token rejected" message in the dashboard.
4. Attempted "fixes" that retried refreshes on 429 extended Anthropic's
   penalty window, making it worse.

The fixes landed in commits 1fb9825 (rotate/sync race), 3fa858e (trace IDs),
81b30a7 (UUID pinning), 05390e2 (per-alias quarantine). This doc explains
what each one prevents and how to tell — from the log — which defense fired
if something goes wrong again.

## The five failure modes and what blocks each

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

**Defense:** In `switchProfile` (`atc-profile.mjs:1089`), after calling
`/account`, we compare the returned UUID against `profile.accountUuid`. If
the pin exists and doesn't match, we **die** with `target-uuid-mismatch`
before writing anything. Logged as:

```
{"actor":"switch","action":"identity-pin-broken",
 "pinned_uuid":"...","observed_uuid":"...","outcome":"switch-abort"}
{"actor":"switch","action":"switch-abort","outcome":"target-uuid-mismatch"}
```

UUIDs are server-assigned and per-account. An attacker cannot forge them,
and Anthropic does not re-issue them. A pin mismatch is ironclad proof of
contamination.

### 3. Claude Code silently rotates an RT while we hold a stale `.cred`

**How it used to fail:** Claude Code's own runtime refreshes RTs in the
background and writes the new token into the keychain. If `.cred` held an
older RT, next switch-back would try to refresh a dead token.

**Defense:** The sync-daemon's job is exactly this — keep `<active>.cred` in
lockstep with keychain rotations. It runs every 10s (safety poll) plus
triggered on `~/.claude.json` changes (watcher). On successful sync, emits:

```
{"action":"sync-write","alias":"primary","prev_rt_fp":"...A","rt_fp":"...B",
 "outcome":"ok","trigger":"safety-poll"}
```

The UUID pin added in Phase 1 means this write only happens after the
keychain identity is verified. So the daemon now has *two* safety checks
active on every write: the rotate lock, AND the UUID match.

### 4. Anthropic account-level rate-limit penalty box

**How it used to fail:** When contamination had already caused 3+ refresh
attempts against primary's account from different lineages, Anthropic's
anti-abuse system flagged the account. Every new RT lineage 429'd on its
first refresh. Our only response was a 10-minute per-lineage cooldown, which
meant 6 retries per hour, each one extending Anthropic's window.

**Defense:** Per-alias budget + auto-quarantine in
`refresh-budget.mjs:recordAttempt`. When we record 3 distinct RT lineages
all returning `rate_limited` within 24 hours for the same alias, we set
`aliases[alias].quarantinedUntil = now + 24h`. All subsequent
`checkBudget(anyRt, { alias })` calls for that alias return
`{ allowed:false, reason:'alias-quarantine' }` — we do not hit Anthropic's
refresh endpoint at all while quarantined.

A new `atc-profile cooldowns` line makes this visible:

```
Alias quarantines (account-level rate-limit suspected):
  primary: quarantined until 2026-04-26T01:30:00.000Z (~23h remaining)
    reason: 3 distinct RT lineages rate-limited within 24h — account-level cap likely
    distinct lineages 429'd: 3, quarantineCount: 1
    override: atc-profile clear-quarantine primary
```

There's an escape hatch (`clear-quarantine`) for when you know Anthropic's
cap has lifted. But the default is to wait — each Anthropic 429 extends
their window, and we want to stop that feedback loop.

### 5. Ambiguity: "which operation failed and why?"

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
Trace e1906c1d-3541-411e-8209-9cf7a8b9077f — 6 events:

+    0ms [switch] switch-start alias=primary outcome=started
+    1ms [switch] disk-read alias=primary rt=...QqaAAA outcome=ok
+    2ms [switch] refresh-request alias=primary phase=proactive outcome=sent
+  105ms [switch] refresh-response alias=primary http=429 outcome=error:rate_limit_error
+  374ms [switch] reactive-refresh-start alias=primary outcome=started
+  374ms [switch] switch-abort alias=primary outcome=rate_limited
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
profile. Running `atc-profile use <alias>` on a healthy AT backfills it
(Phase 1's opportunistic pin).

### 1. Is an alias currently quarantined?

```bash
node ~/Code/AiTrafficControl/dashboard/scripts/atc-profile.mjs cooldowns
```

If output mentions `alias-quarantine`, the account hit Anthropic's penalty
box. The `quarantinedUntil` timestamp tells you how long to wait. Do
**not** `clear-quarantine` unless you're sure Anthropic's cap has lifted
(typically 24h+; Anthropic support can clear it manually).

### 2. Did recent switches fail with contamination?

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

### 3. What's the full story of one failed operation?

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

### 4. Is the sync-daemon healthy?

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
| `actor` | Who emitted: `sync-daemon`, `switch`, `rotate`, `add`, `refresh`, `atc-profile` |
| `action` | What happened: `sync-check`, `switch-start`, `refresh-request`, `identity-pin-broken`, etc. |
| `alias` | Profile alias this event concerns (may be null for global events) |
| `outcome` | Result: `ok`, `unchanged`, `skipped:<reason>`, `error:<type>`, `match`, `mismatch`, etc. |
| `trace_id` | UUID correlating every event in one logical operation. **Always use this to group events.** |
| `switch_id` / `rotate_id` / `add_id` | Operation-specific IDs (also promoted to `trace_id`) |
| `rt_fp` / `at_fp` | Token fingerprints (`...LAST6`) — never raw tokens |
| `pinned_uuid` / `observed_uuid` | Account UUIDs for Phase 1 identity checks |
| `expected_email` / `observed_email` | Soft identity check values |
| `trigger` | Sync-daemon trigger: `safety-poll`, `fs-watch`, `usage-poll`, `startup` |
| `http_status` / `oauth_error` | HTTP response details for refresh attempts |
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
- **`target-uuid-mismatch` / `target-identity-mismatch`** — switch
  pre-flight caught the contamination before touching the keychain.
- **`refresh-response http=429`** repeated on *different* `rt_fp`s for the
  same alias — Anthropic has flagged the account. Phase 3 quarantine will
  auto-fire after the 3rd distinct lineage.
- **`alias-quarantine` in `checkBudget`** — Phase 3 firing. Expected and
  safe; do not override unless you know Anthropic's cap lifted.
- **`sync-skip outcome=skipped:rotate-lock`** for more than a minute —
  probably a hung rotate. Check `profiles.json.rotation`.

Events that are normal and expected:

- `sync-check outcome=unchanged` every ~10s (daemon heartbeat, healthy).
- `rt-rotation` pairs showing `prev_rt_fp → new_rt_fp` (silent RT rotations
  are normal; what matters is that the new one got written to the right
  `.cred`).
- Occasional `refresh-request` / `refresh-response http=200 outcome=ok`
  when an AT nears expiry.

## Configuration knobs

If tuning is needed, these environment variables override defaults:

| Variable | Default | Purpose |
|---|---|---|
| `ATC_REFRESH_DEDUP_MS` | 60000 (1min) | Refresh-request de-dup window |
| `ATC_REFRESH_COOLDOWN_MS` | 600000 (10min) | Per-lineage cooldown after 429 |
| `ATC_ALIAS_BUDGET_WINDOW_MS` | 86400000 (24h) | Per-alias sliding budget window |
| `ATC_ALIAS_BUDGET_MAX_ATTEMPTS` | 6 | Max refreshes per alias per window |
| `ATC_ALIAS_MAX_429_LINEAGES` | 3 | Distinct 429'd lineages before quarantine |
| `ATC_ALIAS_QUARANTINE_MS` | 86400000 (24h) | Quarantine duration |
| `ATC_CREDENTIAL_SAFETY_POLL_MS` | 10000 (10s) | Sync-daemon safety poll interval |

Change these only if you have a specific reason — the defaults are chosen
to be safely below Anthropic's observed account-level thresholds.

## Appendix: the defenses, visually

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  user: atc-profile use primary                                       │
  │  (dashboard: POST /api/profiles/switch { alias:"primary" })          │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 1: alias quarantined? │──── yes ──► abort fast
                │  (Phase 3)                   │            (no Anthropic call)
                └────────────┬───────────────┘
                             │ no
                ┌────────────▼───────────────┐
                │  Gate 2: load <alias>.cred  │──── missing ──► error
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 3: blob email matches │──── mismatch ──► abort
                │  alias.email (pre-refresh)  │   (pre-refresh-identity-mismatch)
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 4: refresh if stale   │
                │  (respects budget + dedup)  │──── 429 ──► recordAttempt,
                └────────────┬───────────────┘          quarantine if 3rd
                             │ fresh AT in hand
                ┌────────────▼───────────────┐
                │  Gate 5: /account live call │
                │  fetch { email, uuid }      │
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Gate 6: UUID matches pin?  │──── mismatch ──► abort
                │  (Phase 1 — hard gate)      │   (identity-pin-broken
                └────────────┬───────────────┘    + target-uuid-mismatch)
                             │ match
                ┌────────────▼───────────────┐
                │  Gate 7: email matches?     │──── mismatch ──► abort
                │  (soft, for legacy profiles)│
                └────────────┬───────────────┘
                             │
                ┌────────────▼───────────────┐
                │  Sync-active: freeze         │
                │  current keychain →          │
                │  <previous-alias>.cred       │── same UUID/email checks ──►
                │                              │   (Phase 1 protects both sides)
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
