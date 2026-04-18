import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderUsageRow, compactPlan, esc, winRow, cardHead } = await import('../../modules/usage-render.mjs');

test('esc escapes HTML entities', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('"quoted"'), '&quot;quoted&quot;');
  assert.equal(esc("'single'"), '&#39;single&#39;');
  assert.equal(esc('a&b'), 'a&amp;b');
});

test('esc handles null and undefined', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('compactPlan normalizes plan names', () => {
  assert.equal(compactPlan('claude pro'), 'Pro');
  assert.equal(compactPlan('CLAUDE MAX'), 'Max');
  assert.equal(compactPlan('Pro'), 'Pro');
  assert.equal(compactPlan('Team Pro'), 'Team Pro');
  assert.equal(compactPlan('Team Max'), 'Team Max');
});

test('compactPlan handles empty plan', () => {
  assert.equal(compactPlan(''), '');
  assert.equal(compactPlan(null), '');
  assert.equal(compactPlan(undefined), '');
});

test('compactPlan truncates long plan names', () => {
  const result = compactPlan('a very long plan name that exceeds limit');
  assert(result.length <= 12);
});

test('winRow renders null window as unavailable', () => {
  const result = winRow(null);
  assert(result.includes('n/a'));
  assert(result.includes('win-meter-empty'));
});

test('winRow renders window with usage percentage', () => {
  const window_ = { usedPercent: 75, label: '5-hour' };
  const result = winRow(window_);
  assert(result.includes('5-hour'));
  assert(result.includes('75'));
});

test('winRow renders window with reset info', () => {
  const window_ = { usedPercent: 50, label: 'weekly', resetIn: '5d' };
  const result = winRow(window_);
  assert(result.includes('50'));
  assert(result.includes('5d'));
});

test('winRow clamps percentage between 0 and 100', () => {
  const window1 = { usedPercent: 150, label: 'test' };
  const result1 = winRow(window1);
  assert(result1.includes('100'));

  const window2 = { usedPercent: -50, label: 'test' };
  const result2 = winRow(window2);
  assert(result2.includes('0'));
});

test('renderUsageRow returns loading state', () => {
  const payload = { loading: true };
  const result = renderUsageRow('claude', 'Claude', payload);
  assert(result.includes('class="usage-row loading"'));
  assert(result.includes('Loading usage'));
});

test('renderUsageRow returns error state', () => {
  const payload = { ok: false, error: 'Authentication failed' };
  const result = renderUsageRow('claude', 'Claude', payload);
  assert(result.includes('class="usage-row error"'));
  assert(result.includes('Authentication failed'));
});

test('renderUsageRow renders successful payload', () => {
  const payload = {
    ok: true,
    plan: 'claude pro',
    primary: { usedPercent: 75, label: '5-hour' },
    secondary: { usedPercent: 50, label: 'weekly' },
  };
  const result = renderUsageRow('claude', 'Claude', payload);
  assert(result.includes('class="usage-row"'));
  assert(!result.includes('error'));
  assert(!result.includes('loading'));
  assert(result.includes('Claude'));
});

test('renderUsageRow includes profile alias pill when provided', () => {
  const payload = { ok: true, plan: 'pro', primary: null, secondary: null };
  const result = renderUsageRow('claude', 'Claude', payload, {
    aliasPill: '<div class="card-alias">personal</div>',
  });
  assert(result.includes('personal'));
});

test('renderUsageRow includes switch button when provided', () => {
  const payload = { ok: true, plan: 'pro', primary: null, secondary: null };
  const result = renderUsageRow('claude', 'Claude', payload, {
    switchBtn: '<button class="switch-btn">Switch</button>',
  });
  assert(result.includes('switch-btn'));
});

test('renderUsageRow shows switching state', () => {
  const payload = { ok: true, plan: 'pro', primary: null, secondary: null };
  const result = renderUsageRow('claude', 'Claude', payload, {
    isProfileSwitching: true,
    switchingAlias: 'work',
  });
  assert(result.includes('switching'));
  assert(result.includes('Switching to work'));
});

test('renderUsageRow uses provided plan display', () => {
  const payload = { ok: true, plan: 'unknown', primary: null, secondary: null };
  const result = renderUsageRow('claude', 'Claude', payload, {
    planDisplay: 'Custom Plan',
  });
  assert(result.includes('Custom Plan'));
});

test('renderUsageRow handles payload without plan', () => {
  const payload = { ok: true, primary: null, secondary: null };
  const result = renderUsageRow('codex', 'Codex', payload);
  assert(result.includes('connected'));
});

test('renderUsageRow includes logo when provided', () => {
  const payload = { ok: true, primary: null, secondary: null };
  const logo = '<svg>test</svg>';
  const result = renderUsageRow('claude', 'Claude', payload, { logo });
  assert(result.includes('<svg>'));
});

test('renderUsageRow includes refresh metadata', () => {
  const payload = {
    ok: true,
    plan: 'pro',
    primary: null,
    secondary: null,
    nextRefreshAt: '2026-04-18T14:30:00Z',
    refreshIntervalMs: 120000,
  };
  const result = renderUsageRow('claude', 'Claude', payload);
  assert(result.includes('data-next-refresh-at'));
  assert(result.includes('2026-04-18T14:30:00Z'));
  assert(result.includes('data-refresh-interval-ms'));
  assert(result.includes('120000'));
});

test('cardHead generates proper card structure', () => {
  const result = cardHead('claude', 'Claude', '<svg/>', '<div class="plan">Pro</div>', '', '', {});
  assert(result.includes('class="usage-head"'));
  assert(result.includes('card-logo'));
  assert(result.includes('card-title'));
  assert(result.includes('Claude'));
});

test('winRow defaults to dash for undefined label', () => {
  const window_ = { usedPercent: 50 };
  const result = winRow(window_);
  assert(result.includes('win-label'));
});
