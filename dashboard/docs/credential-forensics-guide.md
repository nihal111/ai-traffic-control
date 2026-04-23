# Credential Forensics Guide

## Problem Diagnosed

After rotating to secondary profile, the first switch back to primary failed with `rate_limit_error` (HTTP 429), which was then blocked from retrying by the Phase 3 budget gate. This created a situation where the user could not return to the primary profile.

### Root Cause Hypothesis

The `freezeActiveKeychain()` function, when called during credential rotation, was skipping the refresh step when the access token had remaining runway. This allowed a zombie (rate-limited) refresh token to be persisted to disk without validation. When the user later tried to switch back to primary, the endpoint rejected the stale refresh token with a 429, and the budget gate prevented retry, making the profile inaccessible.

## New Forensic Logging Infrastructure

To diagnose the next occurrence, comprehensive event logging was added to track the complete credential lifecycle.

### Event Log Location

All credential events are logged to:

```
dashboard/runtime/logs/credential-events.jsonl
```

Each line is a JSON event with standard fields:
- `ts` — ISO 8601 timestamp (UTC)
- `pid` — process ID (useful if multiple dashboard instances run)
- `actor` — who triggered the event (e.g., "switch", "rotate", "sync-daemon", "freeze")
- `action` — what happened (see below)
- `outcome` — "ok", "error:...", or specific failure reason
- `alias` — profile alias if applicable
- `error` — error message if outcome != "ok"

### Event Types and Forensic Value

#### 1. **disk-read** — Profile credential loaded from disk

Emitted when `loadCredential(alias)` is called.

```json
{
  "actor": "switch",
  "action": "disk-read",
  "alias": "secondary",
  "rt_fp": "...abcdef",      // Refresh token fingerprint (last 6 chars)
  "at_fp": "...xyz123",      // Access token fingerprint
  "expires_at": "2026-04-24T00:16:30Z",  // AT expiry from credential blob
  "mtime": "2026-04-23T16:16:32.979Z",  // When cred file was last written
  "size": 466,               // File size in bytes
  "reason": "load-target",
  "outcome": "ok"
}
```

**Forensic use:** Tells you what token fingerprint was loaded and when it was last synced. If a stale token caused the failure, compare mtime against when the user last successfully used that profile.

---

#### 2. **disk-write** — Profile credential saved to disk

Emitted when `saveCredential(alias, blob, { source, reason })` is called.

```json
{
  "actor": "rotate",
  "action": "disk-write",
  "alias": "primary",
  "rt_fp": "...newtoken",    // New RT fingerprint
  "at_fp": "...newat",       // New AT fingerprint
  "prev_rt_fp": "...oldtoken",  // What was there before (if any)
  "prev_at_fp": "...oldat",
  "prev_mtime": "2026-04-23T17:06:53.544Z",  // Previous file mtime
  "rt_changed": true,        // Did RT actually rotate?
  "expires_at": "2026-04-24T00:16:30Z",  // New AT expiry
  "scopes": ["user:profile", "user:inference"],
  "size": 466,
  "reason": "freeze-save",
  "source": "keychain-export",  // Where did this come from?
  "outcome": "ok"
}
```

**source values:**
- `"keychain-export"` — came from live macOS keychain (sync daemon during polling)
- `"refresh"` — came from successful OAuth refresh response
- `"keychain-export-post-login"` — came from keychain after login/rotation

**Forensic use:** Look at the sequence of disk-writes. If you see:
1. A freeze-save with a token that was later rate-limited, check if `rt_changed: false` (skipped refresh) or if the refresh response was itself rate-limited (check refresh-response events). 
2. The `prev_rt_fp` field tells you what token was replaced — if they match, no rotation happened.
3. `reason` field tells you the context — "freeze-save" during rotation, "sync-active-save" during polling.

---

#### 3. **freeze-start** — Pre-freeze credential state

Emitted at the beginning of `freezeActiveKeychain()` to capture the state before any operations.

```json
{
  "actor": "rotate",
  "action": "freeze-start",
  "alias": "secondary",
  "rt_fp": "...currentrt",
  "expires_at": "2026-04-24T00:16:30Z",
  "needs_refresh": false,    // Does AT expire within 2 minutes?
  "phase": "pre-freeze",
  "outcome": "started"
}
```

**Forensic use:** Tells you the decision point — if `needs_refresh: false`, the code chose to skip refresh. Compare this against what was actually saved to disk (disk-write event).

---

#### 4. **pre-freeze-save** — Identity check before persisting to disk

Emitted when `freezeActiveKeychain()` validates credentials against Claude API before saving.

```json
{
  "actor": "rotate",
  "action": "identity-check",
  "alias": "primary",
  "phase": "pre-freeze-save",
  "expected_email": "user@example.com",
  "observed_email": "user@example.com",
  "subscription_type": "pro",
  "http_status": 200,
  "outcome": "match"  // or "mismatch", "http_error", "network_error"
}
```

**Forensic use:** If outcome != "match", the freeze refused to save and logged an error. If you see `outcome: "ok"` on the freeze-save but later rate-limit errors, the API accepted the creds at freeze time but they became rate-limited externally (Anthropic's endpoint was rate-limiting the lineage).

---

#### 5. **refresh-response** — HTTP response from OAuth token refresh

Emitted after calling the Anthropic token refresh endpoint.

```json
{
  "actor": "switch",
  "action": "refresh-response",
  "http_status": 429,
  "outcome": "rate_limited",
  "error": "rate_limit_error",
  "retry_after": "60",
  "x_ratelimit_remaining": "0",
  "x_ratelimit_limit": "100",
  "x_ratelimit_reset": "1700000000",
  "request_id": "req_abc123"
}
```

**Rate-limit signal headers:**
- `retry_after` — seconds to wait (Anthropic sends 5-10 min for lineage-cap limits)
- `x_ratelimit_remaining: "0"` — exhausted quota
- `request_id` — for support ticket references

**Forensic use:** If refresh returned 429, check the retry_after value. Anthropic's lineage-cap rate limits return long waits (300+ seconds). Transient per-IP limits return shorter waits (10-60 seconds). Log these headers to understand if it's a quota issue or a temporary blip.

---

#### 6. **rt-rotation** — Access token successfully rotated on refresh

Emitted after a successful refresh response is validated and applied.

```json
{
  "actor": "switch",
  "action": "rt-rotation",
  "prev_rt_fp": "...old",
  "new_rt_fp": "...new",
  "rotated": true,        // Single-use rotation (refresh endpoint returned new RT)
  "outcome": "ok"
}
```

**Forensic use:** Confirms that single-use token rotation happened. If you see `rotated: false`, the server did not issue a new refresh token (rotation disabled or server didn't rotate).

---

#### 7. **freeze-refresh-failed** — Refresh attempt during freeze and its outcome

Emitted if refresh is attempted during `freezeActiveKeychain()` and fails.

```json
{
  "actor": "rotate",
  "action": "freeze-refresh-failed",
  "alias": "secondary",
  "outcome": "rate_limited",    // or "fatal", "continue_unrefreshed"
  "error": "429: rate_limit_error",
  "phase": "pre-freeze-save"
}
```

**Outcome values:**
- `"rate_limited"` — 429 response; should prevent disk-save to avoid zombie token
- `"fatal"` — 401/403 (token was rejected); definitely block save
- `"continue_unrefreshed"` — transient error (5xx, timeout); safe to continue with old token

**Forensic use:** Critical signal. If you see `outcome: "rate_limited"` here, check if the subsequent disk-write was blocked (it should be). If disk-write still happened, there's a bug in the safety check.

---

### Sample Investigation Workflow

#### Scenario: "Profile won't switch, says rate_limit_error"

1. **Find the switch-start event:**
   ```bash
   jq 'select(.action == "switch-start")' /path/to/credential-events.jsonl | tail -1
   ```
   This tells you when the switch attempt began and which profiles were involved.

2. **Trace the disk-read:**
   ```bash
   jq 'select(.action == "disk-read" and .alias == "target-profile")' /path/to/credential-events.jsonl | tail -1
   ```
   Note the `mtime`. If it's very old (> 6 days), the refresh token may have aged out.

3. **Check for refresh attempt:**
   ```bash
   jq 'select(.action == "refresh-response")' /path/to/credential-events.jsonl | tail -5
   ```
   If http_status is 429, check `retry_after`:
   - **Long wait (> 300s):** Likely lineage-cap limit (Anthropic rejected the token lineage)
   - **Short wait (< 60s):** Likely transient per-IP limit

4. **Check identity-check outcome:**
   ```bash
   jq 'select(.action == "identity-check")' /path/to/credential-events.jsonl | tail -1
   ```
   If outcome is not "match", the credentials were rejected by API before attempting to use them.

5. **Review disk-write sequence:**
   ```bash
   jq 'select(.action == "disk-write")' /path/to/credential-events.jsonl | tail -10
   ```
   Look for the last write to the problematic profile. Check `source`, `prev_rt_fp`, and `rt_changed` to understand what replaced what.

6. **Check freeze operations (if rotating):**
   ```bash
   jq 'select(.action | match("freeze|pre-freeze"))' /path/to/credential-events.jsonl | tail -10
   ```
   If you see `freeze-start` but no `disk-write` with `source: "refresh"`, it means refresh was skipped. Check `needs_refresh` value.

---

## Best Practices for Debugging

### General Rules

1. **Always look at mtime gaps.** If a profile hasn't been synced (mtime unchanged) for > 6 hours, the refresh token may have aged out.

2. **Correlate disk-read → refresh-response → disk-write.** The order and content tell the whole story:
   - Read: what token was loaded?
   - Response: did refresh succeed? Any rate-limit headers?
   - Write: what was saved and with what source?

3. **Watch for "source" mismatches.** If a disk-write says `source: "keychain-export"` but no concurrent keychain-write event occurred, the keychain wasn't updated (possibly still has old token).

4. **Check the credential-refresh-budget.json state file** for cooldown windows:
   ```bash
   cat dashboard/runtime/credential-refresh-budget.json | jq .
   ```
   If a lineage is in cooldown, all refresh attempts will be blocked until cooldown expires.

5. **Look at both credential-events.jsonl and credential-refresh-budget.json together.** Budget blocks prevent excessive retries, but can hide real issues if the underlying problem isn't fixed.

---

## Forensic Event Log Query Examples

### Find all rate-limit errors in last 24 hours:
```bash
jq 'select(.outcome | match("rate_limited") and (.ts > "2026-04-22T09:00:00"))' credential-events.jsonl
```

### Find all disk-writes where token changed:
```bash
jq 'select(.action == "disk-write" and .rt_changed == true)' credential-events.jsonl
```

### Find all identity-check failures:
```bash
jq 'select(.action == "identity-check" and .outcome != "match")' credential-events.jsonl
```

### Timeline of all operations on a specific profile:
```bash
jq 'select(.alias == "primary") | {ts, actor, action, outcome}' credential-events.jsonl
```

### Find freeze operations and their outcomes:
```bash
jq 'select(.action | match("freeze")) | {ts, action, outcome, phase, reason}' credential-events.jsonl
```

---

## Prevention Measures in Place

1. **Pre-freeze-save identity check:** Before persisting any credentials during rotation, the system now validates them against Claude API. If validation fails (401/403), the save is blocked.

2. **Rate-limit aware freeze:** If the freeze-refresh attempt gets a 429, the save is blocked to prevent persisting a zombie token.

3. **Comprehensive header capture:** All OAuth refresh responses now include Retry-After, x-ratelimit-*, and request-id headers, enabling precise rate-limit categorization.

4. **Provenance tracking:** Every disk write records where the credential came from (keychain, refresh response, post-login), making it possible to trace how a bad token reached disk.

---

## When to Escalate

If you observe:
- **401/403 on identity-check:** User's credentials were rejected by Anthropic. Likely needs re-login.
- **429 with retry_after > 300s:** Lineage-cap rate limit. Likely needs fresh login with new refresh token.
- **Multiple rate-limited refreshes in a row:** Check Anthropic's status page or contact support with the request-id from the events.
- **disk-write with source="keychain-export" but keychain doesn't match:** Keychain/disk sync is out of lockstep; may need manual credential reset.

---

## Testing the Logging

To verify the logging is working:

```bash
# Do a profile rotation
./scripts/atc-profile.mjs --rotate-to secondary

# Then check the events
tail -50 runtime/logs/credential-events.jsonl | jq 'select(.actor == "rotate")'

# Verify you see: freeze-start, disk-read, identity-check, disk-write, rt-rotation events
```

All events should be present and outcomes should be "ok" for a successful rotation.
