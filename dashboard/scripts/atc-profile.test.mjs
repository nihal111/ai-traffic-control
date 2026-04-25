#!/usr/bin/env node
// Unit tests for the pure helpers in atc-profile.mjs. Run with:
//   node dashboard/scripts/atc-profile.test.mjs
// Exits non-zero on any failure.

import {
  blobExpiresAtMs,
  validateAliasIdentity,
  readCredentialBlobEmail,
} from './atc-profile.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── blobExpiresAtMs ──────────────────────────────────────────────────────────
{
  const ms = 1_800_000_000_000;  // ms-since-epoch: year ~2027
  const s = 1_800_000_000;       // s-since-epoch:  same moment
  eq('expiresAtMs: ms-epoch input passes through',
    blobExpiresAtMs(JSON.stringify({ claudeAiOauth: { expiresAt: ms } })),
    ms);
  eq('expiresAtMs: s-epoch input scales to ms',
    blobExpiresAtMs(JSON.stringify({ claudeAiOauth: { expiresAt: s } })),
    s * 1000);
  eq('expiresAtMs: missing expiresAt → null',
    blobExpiresAtMs(JSON.stringify({ claudeAiOauth: {} })),
    null);
  eq('expiresAtMs: non-numeric → null',
    blobExpiresAtMs(JSON.stringify({ claudeAiOauth: { expiresAt: 'later' } })),
    null);
  eq('expiresAtMs: malformed JSON → null',
    blobExpiresAtMs('not json'),
    null);
}

// ── validateAliasIdentity ────────────────────────────────────────────────────
{
  eq(
    'validateAliasIdentity: matching emails pass',
    validateAliasIdentity('User@Example.com', ' user@example.com '),
    { ok: true, reason: 'match' },
  );
  eq(
    'validateAliasIdentity: mismatch fails',
    validateAliasIdentity('one@example.com', 'two@example.com'),
    { ok: false, reason: 'mismatch' },
  );
  eq(
    'validateAliasIdentity: missing observed fails',
    validateAliasIdentity('one@example.com', ''),
    { ok: false, reason: 'unverified' },
  );
  eq(
    'validateAliasIdentity: missing expected is allowed',
    validateAliasIdentity('', 'whatever@example.com'),
    { ok: true, reason: 'no-expected-email' },
  );
  eq(
    'validateAliasIdentity: null observed → unverified',
    validateAliasIdentity('one@example.com', null),
    { ok: false, reason: 'unverified' },
  );
  eq(
    'validateAliasIdentity: undefined observed → unverified',
    validateAliasIdentity('one@example.com', undefined),
    { ok: false, reason: 'unverified' },
  );
  eq(
    'validateAliasIdentity: whitespace observed → unverified',
    validateAliasIdentity('one@example.com', '   '),
    { ok: false, reason: 'unverified' },
  );
  eq(
    'validateAliasIdentity: both null → no-expected-email (vacuously ok)',
    validateAliasIdentity(null, null),
    { ok: true, reason: 'no-expected-email' },
  );
  eq(
    'validateAliasIdentity: case-insensitive match',
    validateAliasIdentity('A@B.COM', 'a@b.com'),
    { ok: true, reason: 'match' },
  );
  eq(
    'validateAliasIdentity: unicode local-part preserved in comparison',
    validateAliasIdentity('Jös@example.com', 'jös@example.com'),
    { ok: true, reason: 'match' },
  );
}

// ── readCredentialBlobEmail ──────────────────────────────────────────────────
{
  eq(
    'readCredentialBlobEmail: emailAddress field returned lowercased',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { emailAddress: 'User@Example.com' } })),
    'user@example.com',
  );
  eq(
    'readCredentialBlobEmail: falls back to email field when emailAddress absent',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { email: 'fallback@example.com' } })),
    'fallback@example.com',
  );
  eq(
    'readCredentialBlobEmail: emailAddress wins over email',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { emailAddress: 'primary@example.com', email: 'legacy@example.com' } })),
    'primary@example.com',
  );
  eq(
    'readCredentialBlobEmail: missing claudeAiOauth → null',
    readCredentialBlobEmail(JSON.stringify({ other: 'value' })),
    null,
  );
  eq(
    'readCredentialBlobEmail: missing email fields → null',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })),
    null,
  );
  eq(
    'readCredentialBlobEmail: malformed JSON → null',
    readCredentialBlobEmail('not-json'),
    null,
  );
  eq(
    'readCredentialBlobEmail: null blob → null',
    readCredentialBlobEmail(null),
    null,
  );
  eq(
    'readCredentialBlobEmail: empty blob → null',
    readCredentialBlobEmail(''),
    null,
  );
  eq(
    'readCredentialBlobEmail: non-string emailAddress → null',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { emailAddress: 42 } })),
    null,
  );
  eq(
    'readCredentialBlobEmail: whitespace-only email → null',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { emailAddress: '   ' } })),
    null,
  );
  eq(
    'readCredentialBlobEmail: trims surrounding whitespace',
    readCredentialBlobEmail(JSON.stringify({ claudeAiOauth: { emailAddress: '  spaced@example.com  ' } })),
    'spaced@example.com',
  );
}

// ── pre-swap identity guard semantics ───────────────────────────────────────
// These exercise the byte-level email guard that runs in switchProfile before
// any keychain or disk write. The guard:
//   1) extracts the embedded email from <alias>.cred
//   2) compares it against the alias's bound email
//   3) aborts if they disagree
{
  function guardDecision(aliasExpected, blob) {
    const observed = readCredentialBlobEmail(blob);
    const result = validateAliasIdentity(aliasExpected, observed);
    if (result.ok) return { proceed: true, reason: result.reason };
    return { proceed: false, reason: result.reason, observed };
  }

  const primaryBlob = JSON.stringify({
    claudeAiOauth: { emailAddress: 'primary@example.com', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
  });
  const mismatchedBlob = JSON.stringify({
    claudeAiOauth: { emailAddress: 'secondary@example.com', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
  });
  const emailMissingBlob = JSON.stringify({
    claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
  });

  eq(
    'pre-swap guard: matching email → proceed',
    guardDecision('primary@example.com', primaryBlob),
    { proceed: true, reason: 'match' },
  );
  eq(
    'pre-swap guard: mismatched email → abort with observed email exposed',
    guardDecision('primary@example.com', mismatchedBlob),
    { proceed: false, reason: 'mismatch', observed: 'secondary@example.com' },
  );
  eq(
    'pre-swap guard: missing email in blob → unverified (caller falls through to live check)',
    guardDecision('primary@example.com', emailMissingBlob),
    { proceed: false, reason: 'unverified', observed: null },
  );
  eq(
    'pre-swap guard: profile has no expected email → vacuously proceed',
    guardDecision('', primaryBlob),
    { proceed: true, reason: 'no-expected-email' },
  );
  eq(
    'pre-swap guard: case-insensitive match passes',
    guardDecision('PRIMARY@example.com', primaryBlob),
    { proceed: true, reason: 'match' },
  );
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}
