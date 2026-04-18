import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildClaudeRefreshMeta, mergeClaudeUsageWindow, defaultProviderRateState, normalizeProviderRateState } = await import('../../modules/usage-cache.mjs');

test('buildClaudeRefreshMeta returns correct refresh timing structure', () => {
  const now = Date.now();
  const result = buildClaudeRefreshMeta(now, 120000);

  assert(Number.isFinite(result.refreshIntervalMs));
  assert.equal(result.refreshIntervalMs, 120000);
  assert(typeof result.nextRefreshAt === 'string');
  assert(result.nextRefreshAt.includes('T'));
  assert(Number.isFinite(result.nextRefreshInSec));
  assert(result.nextRefreshInSec >= 119 && result.nextRefreshInSec <= 120);
});

test('buildClaudeRefreshMeta handles invalid lastAttemptMs', () => {
  const beforeCall = Date.now();
  const result = buildClaudeRefreshMeta(null, 120000);
  const afterCall = Date.now();

  assert.equal(result.refreshIntervalMs, 120000);
  assert(Number.isFinite(result.nextRefreshInSec));
  const nextRefreshMs = new Date(result.nextRefreshAt).getTime();
  assert(nextRefreshMs >= beforeCall && nextRefreshMs <= afterCall + 120000 + 1000);
});

test('buildClaudeRefreshMeta defaults interval when not provided', () => {
  const now = Date.now();
  const result = buildClaudeRefreshMeta(now);

  assert(Number.isFinite(result.refreshIntervalMs));
  assert(result.refreshIntervalMs > 0);
});

test('buildClaudeRefreshMeta handles zero interval', () => {
  const now = Date.now();
  const result = buildClaudeRefreshMeta(now, 0);

  assert(result.refreshIntervalMs > 0);
});

test('mergeClaudeUsageWindow returns null when both null', () => {
  const result = mergeClaudeUsageWindow(null, null);
  assert.equal(result, null);
});

test('mergeClaudeUsageWindow prefers primary usedPercent', () => {
  const primary = { usedPercent: 75, windowMinutes: 300 };
  const fallback = { usedPercent: 50, windowMinutes: 300 };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.usedPercent, 75);
});

test('mergeClaudeUsageWindow falls back to fallback usedPercent', () => {
  const primary = { windowMinutes: 300 };
  const fallback = { usedPercent: 50, windowMinutes: 300 };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.usedPercent, 50);
});

test('mergeClaudeUsageWindow defaults usedPercent to 0', () => {
  const primary = { windowMinutes: 300 };
  const fallback = { windowMinutes: 300 };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.usedPercent, 0);
});

test('mergeClaudeUsageWindow prefers primary resetsAt', () => {
  const resetsAtPrimary = '2026-04-18T14:30:00Z';
  const resetsAtFallback = '2026-04-18T15:00:00Z';
  const primary = { resetsAt: resetsAtPrimary };
  const fallback = { resetsAt: resetsAtFallback };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.resetsAt, resetsAtPrimary);
});

test('mergeClaudeUsageWindow falls back to fallback resetsAt', () => {
  const resetsAtFallback = '2026-04-18T15:00:00Z';
  const primary = { usedPercent: 75 };
  const fallback = { resetsAt: resetsAtFallback };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.resetsAt, resetsAtFallback);
});

test('mergeClaudeUsageWindow returns null resetsAt when neither available', () => {
  const primary = { usedPercent: 75 };
  const fallback = { usedPercent: 50 };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.resetsAt, null);
});

test('mergeClaudeUsageWindow merges resetDescription', () => {
  const primary = { resetDescription: 'in 5 hours' };
  const fallback = { resetDescription: 'in 6 hours' };
  const result = mergeClaudeUsageWindow(primary, fallback);

  assert.equal(result.resetDescription, 'in 5 hours');
});

test('mergeClaudeUsageWindow with only fallback', () => {
  const fallback = { usedPercent: 50, windowMinutes: 300, resetsAt: '2026-04-18T15:00:00Z' };
  const result = mergeClaudeUsageWindow(null, fallback);

  assert.equal(result.usedPercent, 50);
  assert.equal(result.windowMinutes, 300);
  assert.equal(result.resetsAt, '2026-04-18T15:00:00Z');
});

test('defaultProviderRateState returns correct structure', () => {
  const result = defaultProviderRateState();

  assert.equal(result.lastAttemptAtMs, 0);
  assert.equal(result.lastResult, null);
});

test('normalizeProviderRateState with valid entry', () => {
  const entry = { lastAttemptAtMs: 1000, lastResult: { ok: true } };
  const result = normalizeProviderRateState(entry);

  assert.equal(result.lastAttemptAtMs, 1000);
  assert.deepEqual(result.lastResult, { ok: true });
});

test('normalizeProviderRateState clamps invalid lastAttemptAtMs', () => {
  const entry = { lastAttemptAtMs: -100, lastResult: null };
  const result = normalizeProviderRateState(entry);

  assert.equal(result.lastAttemptAtMs, 0);
});

test('normalizeProviderRateState handles zero lastAttemptAtMs', () => {
  const entry = { lastAttemptAtMs: 0, lastResult: null };
  const result = normalizeProviderRateState(entry);

  assert.equal(result.lastAttemptAtMs, 0);
});

test('normalizeProviderRateState returns defaults for null', () => {
  const result = normalizeProviderRateState(null);

  assert.equal(result.lastAttemptAtMs, 0);
  assert.equal(result.lastResult, null);
});

test('normalizeProviderRateState returns defaults for non-object', () => {
  const result = normalizeProviderRateState('invalid');

  assert.equal(result.lastAttemptAtMs, 0);
  assert.equal(result.lastResult, null);
});

test('normalizeProviderRateState strips invalid lastResult', () => {
  const entry = { lastAttemptAtMs: 1000, lastResult: 'invalid' };
  const result = normalizeProviderRateState(entry);

  assert.equal(result.lastAttemptAtMs, 1000);
  assert.equal(result.lastResult, null);
});

test('normalizeProviderRateState with NaN lastAttemptAtMs', () => {
  const entry = { lastAttemptAtMs: NaN, lastResult: null };
  const result = normalizeProviderRateState(entry);

  assert.equal(result.lastAttemptAtMs, 0);
});
