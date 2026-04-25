import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Importing server.mjs triggers the HTTP listen path unless this flag is set.
process.env.DASHBOARD_TEST_IMPORT = '1';

let renderPage;

before(async () => {
  ({ renderPage } = await import('../../server.mjs'));
});

function extractScriptBodies(html) {
  const bodies = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    bodies.push(match[1]);
  }
  return bodies;
}

test('renderPage emits an HTML document with at least one inline script', () => {
  const html = renderPage();
  assert.ok(html.startsWith('<!doctype html>'));
  const scripts = extractScriptBodies(html);
  assert.ok(scripts.length >= 1, `expected >=1 <script> blocks, got ${scripts.length}`);
});

test('regression: pollUsageUntilProfileActive is defined in every script that calls it', () => {
  const html = renderPage();
  const scripts = extractScriptBodies(html);
  let callingScriptCount = 0;
  for (const body of scripts) {
    if (!body.includes('pollUsageUntilProfileActive(')) continue;
    callingScriptCount++;
    assert.ok(
      /function\s+pollUsageUntilProfileActive\b/.test(body),
      'client <script> calls pollUsageUntilProfileActive but never defines it — ' +
        'this was the bug where the function lived only in a Node module (profile-polling.mjs) ' +
        'and the browser crashed with ReferenceError on profile switch.',
    );
  }
  assert.ok(
    callingScriptCount > 0,
    'expected at least one <script> to exercise pollUsageUntilProfileActive — ' +
      'test is guarding against regression of a feature that must still exist',
  );
});

test('injected polling source contains no ES module export syntax', () => {
  const html = renderPage();
  const scripts = extractScriptBodies(html);
  for (const body of scripts) {
    if (!body.includes('function pollUsageUntilProfileActive')) continue;
    // Look only at the slice up through the function's own export, if any,
    // to avoid picking up unrelated "export" words elsewhere in the script.
    assert.ok(
      !/^\s*export\s*\{[^}]*\bpollUsageUntilProfileActive\b[^}]*\}\s*;?\s*$/m.test(body),
      'browser script still contains "export { pollUsageUntilProfileActive }" — ' +
        'stripEsModuleExports did not run or failed',
    );
  }
});

test('switchProfileTo invokes the poller (contract with profile-polling module)', () => {
  const html = renderPage();
  assert.ok(
    html.includes('await pollUsageUntilProfileActive('),
    'switchProfileTo must await pollUsageUntilProfileActive — if this changes, ' +
      'update this test to reflect the new integration contract',
  );
});
