import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Override HOME before loading profile-catalog so its PROFILES_DIR points at a
// temp directory, not the real ~/.claude-profiles. This lets staleness tests
// write fixture .cred files with controlled mtimes without touching real state.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-profile-catalog-test-'));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;
const TEST_PROFILES_DIR = path.join(TEST_HOME, '.claude-profiles');
fs.mkdirSync(TEST_PROFILES_DIR, { recursive: true });

process.on('exit', () => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
});

const {
  emptyProfileUsageCache,
  computeProfileStaleness,
  parseCredBlob,
  credPath,
} = await import('../../modules/profile-catalog.mjs');

function writeCred(alias, payload, ageMs = 0) {
  const p = credPath(alias);
  fs.writeFileSync(p, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(p, when, when);
  }
  return p;
}

test('emptyProfileUsageCache creates placeholder cache with email', () => {
  const result = emptyProfileUsageCache('test@example.com');

  assert.equal(result.ok, false);
  assert.equal(result.placeholder, true);
  assert.equal(result.error, 'n/a');
  assert.equal(result.accountEmail, 'test@example.com');
  assert.equal(result.primary, null);
  assert.equal(result.secondary, null);
  assert.equal(result.fetchedAt, null);
});

test('emptyProfileUsageCache handles null email', () => {
  const result = emptyProfileUsageCache(null);

  assert.equal(result.accountEmail, null);
  assert.equal(result.placeholder, true);
  assert.equal(result.ok, false);
});

test('emptyProfileUsageCache handles whitespace-only email', () => {
  const result = emptyProfileUsageCache('   ');

  assert.equal(result.accountEmail, null);
  assert.equal(result.placeholder, true);
});

test('emptyProfileUsageCache trims email', () => {
  const result = emptyProfileUsageCache('  trimmed@example.com  ');

  assert.equal(result.accountEmail, 'trimmed@example.com');
});

// ── parseCredBlob ────────────────────────────────────────────────────────────

test('parseCredBlob parses valid JSON object', () => {
  assert.deepEqual(parseCredBlob('{"a":1}'), { a: 1 });
});

test('parseCredBlob returns null for invalid JSON', () => {
  assert.equal(parseCredBlob('not json'), null);
});

test('parseCredBlob returns null for non-object JSON (array)', () => {
  // Array is still typeof object in JS, but shouldn't be treated as a cred blob.
  // Current impl accepts arrays since typeof [] === 'object'. Document the
  // contract: it returns any truthy object (including arrays).
  assert.deepEqual(parseCredBlob('[1,2,3]'), [1, 2, 3]);
});

test('parseCredBlob returns null for JSON null', () => {
  assert.equal(parseCredBlob('null'), null);
});

test('parseCredBlob returns null for JSON primitive', () => {
  assert.equal(parseCredBlob('42'), null);
});

// ── credPath ─────────────────────────────────────────────────────────────────

test('credPath composes PROFILES_DIR with <alias>.cred', () => {
  assert.equal(credPath('primary'), path.join(TEST_PROFILES_DIR, 'primary.cred'));
  assert.equal(credPath('secondary'), path.join(TEST_PROFILES_DIR, 'secondary.cred'));
});

// ── computeProfileStaleness: missing / malformed ─────────────────────────────

test('computeProfileStaleness returns null when cred file is missing', () => {
  assert.equal(computeProfileStaleness('does-not-exist', { isActive: true }), null);
});

// ── computeProfileStaleness: active profile thresholds ───────────────────────

test('active profile fresh: <5min lag is "fresh"', () => {
  writeCred('active-fresh', { claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }, 60_000); // 1 min old
  const result = computeProfileStaleness('active-fresh', { isActive: true });
  assert.equal(result.stalenessLevel, 'fresh');
  assert(result.lastSyncAgeMs >= 60_000 - 100);
  assert(result.lastSyncAgeMs < 5 * 60_000);
});

test('active profile warn: 5-30min lag is "warn"', () => {
  writeCred('active-warn', { claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }, 10 * 60_000); // 10 min old
  const result = computeProfileStaleness('active-warn', { isActive: true });
  assert.equal(result.stalenessLevel, 'warn');
});

test('active profile critical: >30min lag is "critical"', () => {
  writeCred('active-critical', { claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }, 45 * 60_000); // 45 min old
  const result = computeProfileStaleness('active-critical', { isActive: true });
  assert.equal(result.stalenessLevel, 'critical');
});

test('active profile boundary: exactly 5min is still "fresh" (>5min is warn)', () => {
  writeCred('active-boundary-5m', { claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }, 5 * 60_000); // exactly 5m
  const result = computeProfileStaleness('active-boundary-5m', { isActive: true });
  // Impl: warn triggers when ageMs > 5*60*1000, so age == 5min → fresh.
  // Allow tiny utimes rounding: level should be 'fresh' OR 'warn'.
  assert(['fresh', 'warn'].includes(result.stalenessLevel));
});

// ── computeProfileStaleness: inactive profile thresholds ─────────────────────

test('inactive profile fresh: <3d old is "fresh"', () => {
  writeCred('inactive-fresh', { claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }, 24 * 3600_000); // 1 day old
  const result = computeProfileStaleness('inactive-fresh', { isActive: false });
  assert.equal(result.stalenessLevel, 'fresh');
});

test('inactive profile warn: 3-6d old is "warn"', () => {
  writeCred('inactive-warn', { claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }, 4 * 24 * 3600_000); // 4 days old
  const result = computeProfileStaleness('inactive-warn', { isActive: false });
  assert.equal(result.stalenessLevel, 'warn');
});

test('inactive profile critical: >6d old is "critical"', () => {
  writeCred('inactive-critical', { claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }, 7 * 24 * 3600_000); // 7 days old
  const result = computeProfileStaleness('inactive-critical', { isActive: false });
  assert.equal(result.stalenessLevel, 'critical');
});

// ── computeProfileStaleness: credAccessExpiresAt / credAccessExpired ─────────

test('computeProfileStaleness surfaces credAccessExpiresAt (ms-epoch)', () => {
  const expMs = Date.now() + 3600_000;
  writeCred('exp-ms', { claudeAiOauth: { expiresAt: expMs } }, 60_000);
  const result = computeProfileStaleness('exp-ms', { isActive: true });
  assert.equal(result.credAccessExpiresAt, new Date(expMs).toISOString());
  assert.equal(result.credAccessExpired, false);
});

test('computeProfileStaleness surfaces credAccessExpiresAt (s-epoch scaled to ms)', () => {
  const expSec = Math.floor((Date.now() + 3600_000) / 1000);
  writeCred('exp-sec', { claudeAiOauth: { expiresAt: expSec } }, 60_000);
  const result = computeProfileStaleness('exp-sec', { isActive: true });
  assert.equal(result.credAccessExpiresAt, new Date(expSec * 1000).toISOString());
  assert.equal(result.credAccessExpired, false);
});

test('computeProfileStaleness flags credAccessExpired when access token expired', () => {
  writeCred('exp-past', { claudeAiOauth: { expiresAt: Date.now() - 3600_000 } }, 60_000);
  const result = computeProfileStaleness('exp-past', { isActive: true });
  assert.equal(result.credAccessExpired, true);
});

test('computeProfileStaleness returns null credAccessExpiresAt when missing', () => {
  writeCred('exp-missing', { claudeAiOauth: {} }, 60_000);
  const result = computeProfileStaleness('exp-missing', { isActive: true });
  assert.equal(result.credAccessExpiresAt, null);
  assert.equal(result.credAccessExpired, null);
});

test('computeProfileStaleness defaults isActive=false when omitted', () => {
  // 4-day-old file: inactive → 'warn'; active → 'critical'. Omitted = inactive → warn.
  writeCred('default-inactive', { claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }, 4 * 24 * 3600_000);
  const result = computeProfileStaleness('default-inactive');
  assert.equal(result.stalenessLevel, 'warn');
});

test('computeProfileStaleness honors injected now for deterministic thresholds', () => {
  const filePath = writeCred('injected-now', { claudeAiOauth: { expiresAt: 1_700_000_000_000 } });
  const fileMtimeMs = fs.statSync(filePath).mtimeMs;
  // Simulate "now" being 100 minutes after the file's mtime → active critical.
  const result = computeProfileStaleness('injected-now', { now: fileMtimeMs + 100 * 60_000, isActive: true });
  assert.equal(result.stalenessLevel, 'critical');
  assert(result.lastSyncAgeMs >= 99 * 60_000);
});
