import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Pin the runtime dir to a temp path BEFORE importing the module so that any
// module-level default captured at import time still points somewhere safe.
const TEST_RUNTIME = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-credential-events-test-'));
process.env.ATC_DASHBOARD_RUNTIME_DIR = TEST_RUNTIME;

process.on('exit', () => {
  try { fs.rmSync(TEST_RUNTIME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { recordEvent, tailEvents, fingerprint, parseDuration, logFile, generateTraceId, filterEventsByTrace } = await import('../../modules/credential-events.mjs');

test('fingerprint masks long tokens to ...LAST6', () => {
  assert.equal(fingerprint('sk-ant-ort01-abcdef'), '...abcdef');
  assert.equal(fingerprint('sk-ant-ort01-xyz12345'), '...345'.slice(0, 3) + 'xyz12345'.slice(-6));
});

test('fingerprint returns null for empty', () => {
  assert.equal(fingerprint(null), null);
  assert.equal(fingerprint(''), null);
});

test('fingerprint short tokens get *-prefix', () => {
  assert.equal(fingerprint('abc'), '*abc');
});

test('recordEvent + tailEvents round-trip', () => {
  recordEvent({ actor: 'test', action: 'hello', alias: 'primary', outcome: 'ok' });
  recordEvent({ actor: 'test', action: 'world', alias: 'secondary', outcome: 'skip' });
  const events = tailEvents({ limit: 10 });
  assert.ok(events.length >= 2);
  const last = events[events.length - 1];
  assert.equal(last.alias, 'secondary');
  assert.equal(last.action, 'world');
});

test('tailEvents filters by alias', () => {
  const events = tailEvents({ alias: 'primary', limit: 50 });
  for (const e of events) {
    if (e.alias) assert.equal(e.alias, 'primary');
  }
});

test('recordEvent never writes raw refreshToken', () => {
  recordEvent({
    actor: 'test',
    action: 'should-mask',
    refreshToken: 'sk-ant-ort01-SENSITIVE',
    accessToken: 'sk-ant-oat01-SENSITIVE',
    outcome: 'ok',
  });
  const raw = fs.readFileSync(logFile(), 'utf8');
  assert.ok(!raw.includes('SENSITIVE'));
  assert.ok(raw.includes('...SITIVE') || raw.includes('...NSITIV'));
});

test('parseDuration handles s/m/h/d suffixes', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('12345'), 12345);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(null), null);
});

test('generateTraceId returns a valid UUID v4', () => {
  const id = generateTraceId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Collision resistance sanity (not a cryptographic test, just "distinct"):
  const second = generateTraceId();
  assert.notEqual(id, second);
});

test('recordEvent auto-promotes switch_id to trace_id when trace_id missing', () => {
  const switchId = generateTraceId();
  const written = recordEvent({ actor: 'switch', action: 'switch-start', switch_id: switchId, outcome: 'started' });
  assert.equal(written.trace_id, switchId, 'switch_id should become trace_id');
});

test('recordEvent auto-promotes rotate_id to trace_id when trace_id missing', () => {
  const rotateId = generateTraceId();
  const written = recordEvent({ actor: 'rotate', action: 'rotate-start', rotate_id: rotateId, outcome: 'started' });
  assert.equal(written.trace_id, rotateId);
});

test('recordEvent: explicit trace_id takes precedence over switch_id/rotate_id', () => {
  const explicitTrace = generateTraceId();
  const switchId = generateTraceId();
  const written = recordEvent({
    actor: 'switch',
    action: 'nested-op',
    trace_id: explicitTrace,
    switch_id: switchId,
    outcome: 'ok',
  });
  assert.equal(written.trace_id, explicitTrace, 'explicit trace_id must win');
});

test('recordEvent: preserves null trace_id when no correlation id present', () => {
  const written = recordEvent({ actor: 'sync-daemon', action: 'sync-check', outcome: 'unchanged' });
  assert.equal(written.trace_id, null);
});

test('filterEventsByTrace matches events across any correlation field', () => {
  const traceId = generateTraceId();
  const events = [
    { action: 'a', trace_id: traceId, outcome: 'x' },
    { action: 'b', switch_id: traceId, outcome: 'x' },
    { action: 'c', rotate_id: traceId, outcome: 'x' },
    { action: 'd', add_id: traceId, outcome: 'x' },
    { action: 'unrelated', trace_id: 'other', outcome: 'x' },
    { action: 'no-ids', outcome: 'x' },
  ];
  const filtered = filterEventsByTrace(events, traceId);
  assert.equal(filtered.length, 4);
  assert.deepEqual(filtered.map(e => e.action), ['a', 'b', 'c', 'd']);
});

test('filterEventsByTrace returns [] for empty/null id', () => {
  assert.deepEqual(filterEventsByTrace([{ trace_id: 'x' }], null), []);
  assert.deepEqual(filterEventsByTrace([{ trace_id: 'x' }], ''), []);
  assert.deepEqual(filterEventsByTrace([{ trace_id: 'x' }], '   '), []);
});
