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

const { recordEvent, tailEvents, fingerprint, parseDuration, logFile } = await import('../../modules/credential-events.mjs');

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
