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

const { checkBudget, recordAttempt, forgetLineage, listCooldowns } = await import('../../modules/refresh-budget.mjs');

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
