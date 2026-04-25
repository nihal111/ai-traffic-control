import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_RUNTIME = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-refresh-budget-test-'));
process.env.ATC_DASHBOARD_RUNTIME_DIR = TEST_RUNTIME;
process.env.ATC_REFRESH_BUDGET_FILE = path.join(TEST_RUNTIME, 'budget.json');

process.on('exit', () => {
  try { fs.rmSync(TEST_RUNTIME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { checkBudget, recordAttempt, forgetLineage, listCooldowns, aliasQuarantine, clearAliasQuarantine, ALIAS_MAX_ATTEMPTS, ALIAS_MAX_429_DISTINCT_LINEAGES, ALIAS_WINDOW_MS, ALIAS_QUARANTINE_MS } = await import('../../modules/refresh-budget.mjs');

function clearBudget() {
  try { fs.rmSync(process.env.ATC_REFRESH_BUDGET_FILE, { force: true }); } catch { /* ignore */ }
}

test('checkBudget allows unknown lineage', () => {
  clearBudget();
  const r = checkBudget('rt-fresh');
  assert.equal(r.allowed, true);
});

test('recording ok allows re-attempt after dedup window', () => {
  clearBudget();
  recordAttempt('rt-a', { outcome: 'ok', alias: 'primary' });
  const rDedup = checkBudget('rt-a', { nowMs: Date.now() });
  assert.equal(rDedup.allowed, false);
  assert.equal(rDedup.reason, 'dedup');
  const rLater = checkBudget('rt-a', { nowMs: Date.now() + 61 * 1000 });
  assert.equal(rLater.allowed, true);
});

test('rate_limited outcome sets a cooldown', () => {
  clearBudget();
  recordAttempt('rt-b', { outcome: 'rate_limited', alias: 'secondary', error: '429: rate_limit_error' });
  const r = checkBudget('rt-b');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.alias, 'secondary');
  assert.ok(r.retryAt > Date.now());
  assert.ok(r.retryAt <= Date.now() + 11 * 60 * 1000);
});

test('listCooldowns returns active rate-limited lineages', () => {
  clearBudget();
  recordAttempt('rt-c', { outcome: 'rate_limited', alias: 'tertiary' });
  const cooldowns = listCooldowns();
  assert.ok(cooldowns.some((c) => c.rtFp === 'rt-c' && c.alias === 'tertiary'));
});

test('cooldown expires after cooldown window', () => {
  clearBudget();
  recordAttempt('rt-d', { outcome: 'rate_limited', alias: 'primary', nowMs: 1000 });
  const stillCold = checkBudget('rt-d', { nowMs: 2000 });
  assert.equal(stillCold.allowed, false);
  const warmAgain = checkBudget('rt-d', { nowMs: 1000 + 11 * 60 * 1000 });
  assert.equal(warmAgain.allowed, true);
});

test('forgetLineage removes state entirely', () => {
  clearBudget();
  recordAttempt('rt-e', { outcome: 'rate_limited', alias: 'primary' });
  forgetLineage('rt-e');
  const r = checkBudget('rt-e');
  assert.equal(r.allowed, true);
});

test('recording ok after rate_limited clears the cooldown', () => {
  clearBudget();
  recordAttempt('rt-f', { outcome: 'rate_limited', alias: 'primary' });
  recordAttempt('rt-f', { outcome: 'ok', alias: 'primary' });
  const r = checkBudget('rt-f', { nowMs: Date.now() + 61 * 1000 });
  assert.equal(r.allowed, true);
});

// ── Per-alias budget + quarantine (Phase 3) ──────────────────────────────────

test('3 cross-lineage 429s on same alias triggers alias-quarantine', () => {
  clearBudget();
  const alias = 'primary';
  const nowMs = 1_000_000_000_000;
  recordAttempt('rt-1', { outcome: 'rate_limited', alias, nowMs });
  recordAttempt('rt-2', { outcome: 'rate_limited', alias, nowMs: nowMs + 1000 });
  // Still below threshold after 2 distinct lineages
  assert.equal(aliasQuarantine(alias, { nowMs: nowMs + 2000 }), null, 'should not be quarantined yet');
  recordAttempt('rt-3', { outcome: 'rate_limited', alias, nowMs: nowMs + 2000 });
  // 3rd distinct lineage — quarantine fires
  const q = aliasQuarantine(alias, { nowMs: nowMs + 2000 });
  assert.ok(q, 'quarantine should be active');
  assert.equal(q.alias, alias);
  assert.ok(q.retryAt > nowMs + 2000);
});

test('quarantined alias blocks refresh even on a FRESH lineage', () => {
  clearBudget();
  const alias = 'primary';
  const nowMs = 2_000_000_000_000;
  recordAttempt('rt-1', { outcome: 'rate_limited', alias, nowMs });
  recordAttempt('rt-2', { outcome: 'rate_limited', alias, nowMs: nowMs + 1 });
  recordAttempt('rt-3', { outcome: 'rate_limited', alias, nowMs: nowMs + 2 });
  // A brand-new lineage never seen before should STILL be blocked by the alias quarantine
  const result = checkBudget('rt-brand-new', { alias, nowMs: nowMs + 100 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'alias-quarantine');
  assert.equal(result.alias, alias);
});

test('quarantine does not leak across aliases', () => {
  clearBudget();
  const nowMs = 3_000_000_000_000;
  recordAttempt('rt-a1', { outcome: 'rate_limited', alias: 'primary', nowMs });
  recordAttempt('rt-a2', { outcome: 'rate_limited', alias: 'primary', nowMs: nowMs + 1 });
  recordAttempt('rt-a3', { outcome: 'rate_limited', alias: 'primary', nowMs: nowMs + 2 });
  assert.ok(aliasQuarantine('primary', { nowMs: nowMs + 10 }));
  // Secondary is untouched — must remain free
  const secondaryCheck = checkBudget('rt-sec', { alias: 'secondary', nowMs: nowMs + 10 });
  assert.equal(secondaryCheck.allowed, true);
});

test('recording ok for an alias clears its rate-limit lineage tracker', () => {
  clearBudget();
  const alias = 'primary';
  const nowMs = 4_000_000_000_000;
  recordAttempt('rt-a', { outcome: 'rate_limited', alias, nowMs });
  recordAttempt('rt-b', { outcome: 'rate_limited', alias, nowMs: nowMs + 1 });
  // A successful refresh proves account is healthy — tracker resets
  recordAttempt('rt-c', { outcome: 'ok', alias, nowMs: nowMs + 2 });
  recordAttempt('rt-d', { outcome: 'rate_limited', alias, nowMs: nowMs + 3 });
  // Should be only 1 lineage 429'd since the reset; quarantine should NOT fire
  assert.equal(aliasQuarantine(alias, { nowMs: nowMs + 10 }), null);
});

test('per-alias attempt cap blocks even non-429 refreshes', () => {
  clearBudget();
  const alias = 'primary';
  const baseTs = 5_000_000_000_000;
  // Hit the per-24h cap (default 6 attempts)
  for (let i = 0; i < ALIAS_MAX_ATTEMPTS; i++) {
    recordAttempt(`rt-ok-${i}`, { outcome: 'ok', alias, nowMs: baseTs + i * 1000 });
  }
  const check = checkBudget('rt-new', { alias, nowMs: baseTs + ALIAS_MAX_ATTEMPTS * 1000 });
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'alias-budget');
  assert.ok(check.retryAt > baseTs);
});

test('clearAliasQuarantine lifts the block', () => {
  clearBudget();
  const alias = 'primary';
  recordAttempt('rt-1', { outcome: 'rate_limited', alias });
  recordAttempt('rt-2', { outcome: 'rate_limited', alias });
  recordAttempt('rt-3', { outcome: 'rate_limited', alias });
  assert.ok(aliasQuarantine(alias));
  const cleared = clearAliasQuarantine(alias);
  assert.equal(cleared, true);
  assert.equal(aliasQuarantine(alias), null);
  // Second call is a no-op
  assert.equal(clearAliasQuarantine(alias), false);
});

test('listCooldowns surfaces alias quarantines distinctly', () => {
  clearBudget();
  const alias = 'primary';
  recordAttempt('rt-1', { outcome: 'rate_limited', alias });
  recordAttempt('rt-2', { outcome: 'rate_limited', alias });
  recordAttempt('rt-3', { outcome: 'rate_limited', alias });
  const cds = listCooldowns();
  const q = cds.find((c) => c.kind === 'alias-quarantine');
  assert.ok(q, 'should have alias-quarantine entry');
  assert.equal(q.alias, alias);
  assert.ok(q.rateLimitedLineages >= 3);
});

test('attempts older than ALIAS_WINDOW_MS drop from the sliding window', () => {
  clearBudget();
  const alias = 'primary';
  const longAgo = Date.now() - ALIAS_WINDOW_MS - 60_000;
  // Ancient attempts shouldn't count
  for (let i = 0; i < ALIAS_MAX_ATTEMPTS + 2; i++) {
    recordAttempt(`rt-old-${i}`, { outcome: 'ok', alias, nowMs: longAgo + i * 100 });
  }
  const check = checkBudget('rt-new', { alias });
  assert.equal(check.allowed, true, 'old attempts should have dropped out of the window');
});
