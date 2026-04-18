import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { emptyProfileUsageCache } = await import('../../modules/profile-catalog.mjs');

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
