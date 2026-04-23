#!/usr/bin/env node
// Unit tests for the pure helpers in atc-profile.mjs. Run with:
//   node dashboard/scripts/atc-profile.test.mjs
// Exits non-zero on any failure.

import {
  blobExpiresAtMs,
  blobNeedsRefresh,
  classifyRefreshError,
  isFatalRefreshError,
  buildRefreshedBlob,
  parseRefreshResponse,
  parseRefreshResponseWithHeaders,
  pickRateLimitHeaders,
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

function throws(name, fn, expectedCode) {
  try {
    fn();
    check(name, false, 'expected throw, got none');
  } catch (err) {
    if (expectedCode && err.oauthError !== expectedCode) {
      check(name, false, `expected oauthError=${expectedCode}, got ${err.oauthError}`);
    } else {
      check(name, true);
    }
  }
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

// ── blobNeedsRefresh ─────────────────────────────────────────────────────────
{
  const now = Date.now();
  const fresh = JSON.stringify({ claudeAiOauth: { expiresAt: now + 60 * 60 * 1000 } });
  const nearExpiry = JSON.stringify({ claudeAiOauth: { expiresAt: now + 30 * 1000 } });
  const expired = JSON.stringify({ claudeAiOauth: { expiresAt: now - 1000 } });
  const missing = JSON.stringify({ claudeAiOauth: {} });

  eq('needsRefresh: comfortably fresh → false',
    blobNeedsRefresh(fresh),
    false);
  eq('needsRefresh: within 2-minute skew → true',
    blobNeedsRefresh(nearExpiry),
    true);
  eq('needsRefresh: already expired → true',
    blobNeedsRefresh(expired),
    true);
  eq('needsRefresh: missing expiresAt → true (conservative)',
    blobNeedsRefresh(missing),
    true);
  // Custom skew
  eq('needsRefresh: custom skew shorter than default',
    blobNeedsRefresh(nearExpiry, 0),
    false);
}

// ── classifyRefreshError ─────────────────────────────────────────────────────
{
  // OAuth-standard shape
  eq('classify: OAuth string error',
    classifyRefreshError(400, { error: 'invalid_grant', error_description: 'token revoked' }, ''),
    { code: 'invalid_grant', desc: 'token revoked' });

  // Anthropic nested-object shape — this is the one the real endpoint returned
  // during live testing and that previously stringified to "[object Object]".
  eq('classify: Anthropic nested-object error (the regression)',
    classifyRefreshError(429, { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }, ''),
    { code: 'rate_limit_error', desc: 'Rate limited. Please try again later.' });

  // Missing payload → use HTTP status as synthetic code, response body as desc
  eq('classify: no payload, raw body fallback',
    classifyRefreshError(502, null, 'Bad Gateway'),
    { code: 'http_502', desc: 'Bad Gateway' });

  // Payload without recognizable error field
  eq('classify: payload with neither error nor message',
    classifyRefreshError(500, { foo: 'bar' }, 'something'),
    { code: 'http_500', desc: 'something' });
}

// ── isFatalRefreshError ──────────────────────────────────────────────────────
{
  eq('fatal: invalid_grant → true', isFatalRefreshError('invalid_grant', 400), true);
  eq('fatal: missing_refresh_token → true', isFatalRefreshError('missing_refresh_token', 0), true);
  eq('fatal: 401 → true', isFatalRefreshError('http_401', 401), true);
  eq('fatal: rate_limit_error → false (retry later)', isFatalRefreshError('rate_limit_error', 429), false);
  eq('fatal: network_error → false', isFatalRefreshError('network_error', 0), false);
  eq('fatal: 503 → false (transient)', isFatalRefreshError('http_503', 503), false);
}

// ── buildRefreshedBlob ───────────────────────────────────────────────────────
{
  const prev = {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-OLD',
      refreshToken: 'sk-ant-ort01-OLD',
      expiresAt: 1,
      scopes: ['user:profile'],
      subscriptionType: 'pro',
    },
    otherTopLevelField: 'preserve-me',
  };

  // Happy path: both tokens rotated
  {
    const payload = {
      access_token: 'sk-ant-oat01-NEW',
      refresh_token: 'sk-ant-ort01-NEW',
      expires_in: 28800,
    };
    const blob = buildRefreshedBlob(prev, payload, 1_700_000_000_000);
    eq('buildRefreshed: rotates accessToken',  blob.claudeAiOauth.accessToken, 'sk-ant-oat01-NEW');
    eq('buildRefreshed: rotates refreshToken', blob.claudeAiOauth.refreshToken, 'sk-ant-ort01-NEW');
    eq('buildRefreshed: computes expiresAt from nowMs + expires_in*1000',
      blob.claudeAiOauth.expiresAt,
      1_700_000_000_000 + 28800 * 1000);
    eq('buildRefreshed: preserves scopes',           blob.claudeAiOauth.scopes, ['user:profile']);
    eq('buildRefreshed: preserves subscriptionType', blob.claudeAiOauth.subscriptionType, 'pro');
    eq('buildRefreshed: preserves unrelated top-level fields', blob.otherTopLevelField, 'preserve-me');
  }

  // Rotation-disabled: server reissues access only, we keep prev refreshToken.
  {
    const payload = { access_token: 'sk-ant-oat01-NEW2', expires_in: 3600 };
    const blob = buildRefreshedBlob(prev, payload, 0);
    eq('buildRefreshed: no new refresh_token → reuse saved',
      blob.claudeAiOauth.refreshToken,
      'sk-ant-ort01-OLD');
  }

  // Malformed responses
  throws('buildRefreshed: missing access_token throws malformed_response',
    () => buildRefreshedBlob(prev, { expires_in: 3600 }),
    'malformed_response');
  throws('buildRefreshed: missing expires_in throws malformed_response',
    () => buildRefreshedBlob(prev, { access_token: 'x' }),
    'malformed_response');
  throws('buildRefreshed: negative expires_in throws malformed_response',
    () => buildRefreshedBlob(prev, { access_token: 'x', expires_in: -1 }),
    'malformed_response');
  throws('buildRefreshed: no refresh_token anywhere throws malformed_response',
    () => buildRefreshedBlob(
      { claudeAiOauth: { refreshToken: '' } },
      { access_token: 'x', expires_in: 3600 }),
    'malformed_response');
}

// ── parseRefreshResponse ─────────────────────────────────────────────────────
{
  const ok = parseRefreshResponse('{"access_token":"x","expires_in":3600}\n200');
  eq('parseRefresh: 200 status extracted', ok.httpStatus, 200);
  eq('parseRefresh: payload JSON parsed',  ok.payload?.access_token, 'x');

  const err = parseRefreshResponse('{"error":{"type":"rate_limit_error","message":"slow down"}}\n429');
  eq('parseRefresh: error status extracted', err.httpStatus, 429);
  eq('parseRefresh: error payload parsed',   err.payload?.error?.type, 'rate_limit_error');

  const nonJson = parseRefreshResponse('<html>Gateway Timeout</html>\n504');
  eq('parseRefresh: non-JSON body → payload null', nonJson.payload, null);
  eq('parseRefresh: non-JSON body preserved',       nonJson.responseBody, '<html>Gateway Timeout</html>');
  eq('parseRefresh: non-JSON status extracted',     nonJson.httpStatus, 504);

  const noNewline = parseRefreshResponse('200');
  eq('parseRefresh: malformed (no newline) → httpStatus 0, body=raw',
    { status: noNewline.httpStatus, body: noNewline.responseBody },
    { status: 0, body: '200' });
}

// ── parseRefreshResponseWithHeaders ──────────────────────────────────────────
{
  const okRaw =
    'HTTP/2 200\r\n' +
    'content-type: application/json\r\n' +
    'request-id: req_abc123\r\n' +
    '\r\n' +
    '{"access_token":"x","expires_in":3600}\n200';
  const ok = parseRefreshResponseWithHeaders(okRaw);
  eq('parseWithHeaders: 200 status extracted', ok.httpStatus, 200);
  eq('parseWithHeaders: payload JSON parsed', ok.payload?.access_token, 'x');
  eq('parseWithHeaders: request-id header captured', ok.headers['request-id'], 'req_abc123');

  const errRaw =
    'HTTP/2 429\r\n' +
    'retry-after: 60\r\n' +
    'x-ratelimit-remaining: 0\r\n' +
    'anthropic-request-id: req_xyz\r\n' +
    '\r\n' +
    '{"error":{"type":"rate_limit_error","message":"slow down"}}\n429';
  const err = parseRefreshResponseWithHeaders(errRaw);
  eq('parseWithHeaders: 429 status', err.httpStatus, 429);
  eq('parseWithHeaders: retry-after captured', err.headers['retry-after'], '60');
  eq('parseWithHeaders: ratelimit-remaining captured', err.headers['x-ratelimit-remaining'], '0');
  eq('parseWithHeaders: anthropic-request-id captured', err.headers['anthropic-request-id'], 'req_xyz');

  // Body-only input (no header block at all) should still extract status.
  const bare = parseRefreshResponseWithHeaders('{"access_token":"x","expires_in":3600}\n200');
  eq('parseWithHeaders: bare body still parses', bare.payload?.access_token, 'x');
  eq('parseWithHeaders: bare body still returns status', bare.httpStatus, 200);
}

// ── pickRateLimitHeaders ─────────────────────────────────────────────────────
{
  const picked = pickRateLimitHeaders({
    'retry-after': '120',
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1700000000',
    'anthropic-request-id': 'req_abc',
    'content-type': 'application/json',
    'date': 'Mon, 01 Jan 2026 00:00:00 GMT',
  });
  eq('pickRateLimit: retry_after', picked.retry_after, '120');
  eq('pickRateLimit: ratelimit keys snake_cased', picked.x_ratelimit_remaining, '0');
  eq('pickRateLimit: request_id canonicalized', picked.request_id, 'req_abc');
  eq('pickRateLimit: content-type dropped', picked['content-type'], undefined);
  eq('pickRateLimit: date dropped', picked.date, undefined);
  eq('pickRateLimit: empty input', JSON.stringify(pickRateLimitHeaders(null)), '{}');
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}
