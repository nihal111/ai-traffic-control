// Structured credential event log.
//
// Every credential-touching operation — keychain read, disk write, identity
// check, refresh request/response — writes one JSONL line here. The log is
// the authoritative post-mortem record: when a switch fails or a profile
// goes silently stale, the sequence of events immediately before it is what
// we need to understand what happened.
//
// Tokens are never logged in full — only last-6-char fingerprints.

import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Resolve the log file at call time, not module load, so server.mjs setting
// ATC_DASHBOARD_RUNTIME_DIR after import (or tests overriding it) picks up
// the intended path.
function defaultLogDir() {
  return path.join(
    process.env.ATC_DASHBOARD_RUNTIME_DIR ||
      path.join(process.cwd(), 'dashboard', 'runtime'),
    'logs',
  );
}
function logFile() {
  const root = process.env.ATC_CREDENTIAL_LOG_DIR || defaultLogDir();
  return path.join(root, 'credential-events.jsonl');
}

// Rotate if the log exceeds this size. 50MB is ~250k events at ~200 bytes each,
// plenty of room for weeks of operation. On rotation we keep the last file as
// credential-events.1.jsonl — old rotations overwrite each other, we only
// care about the recent window.
const MAX_LOG_BYTES = Number(process.env.ATC_CREDENTIAL_LOG_MAX_BYTES || 50 * 1024 * 1024);

function ensureLogDir() {
  const file = logFile();
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
}

function maybeRotate() {
  const file = logFile();
  try {
    const stat = fsSync.statSync(file);
    if (stat.size <= MAX_LOG_BYTES) return;
    const rotated = `${file}.1`;
    try { fsSync.rmSync(rotated, { force: true }); } catch { /* ignore */ }
    fsSync.renameSync(file, rotated);
  } catch {
    // file doesn't exist — nothing to rotate
  }
}

// Fingerprint a token for logging: last 6 characters plus a short length hash
// prefix so two tokens with the same tail don't collide. Never log full tokens.
function fingerprint(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  if (raw.length <= 6) return `*${raw}`;
  return `...${raw.slice(-6)}`;
}

// Emit a single event. Non-throwing: event logging must never break a
// credential operation. Returns the event written (or null on error).
function recordEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    actor: String(event.actor || 'unknown'),
    action: String(event.action || 'unknown'),
    ...event,
  };
  // Replace secret-ish fields with fingerprints if the caller forgot.
  if (payload.refreshToken) {
    payload.rt_fp = fingerprint(payload.refreshToken);
    delete payload.refreshToken;
  }
  if (payload.accessToken) {
    payload.at_fp = fingerprint(payload.accessToken);
    delete payload.accessToken;
  }
  const line = JSON.stringify(payload) + '\n';
  try {
    ensureLogDir();
    maybeRotate();
    fsSync.appendFileSync(logFile(), line, { encoding: 'utf8', mode: 0o600 });
    return payload;
  } catch {
    return null;
  }
}

// Tail the log for CLI/dashboard display. Returns events newest-last.
function tailEvents({ alias = null, sinceMs = null, limit = 100, includeRotated = false } = {}) {
  const file = logFile();
  const files = [file];
  if (includeRotated) files.push(`${file}.1`);
  const events = [];
  for (const f of files) {
    let raw;
    try { raw = fsSync.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (alias && parsed.alias && parsed.alias !== alias) continue;
      if (sinceMs != null) {
        const ts = Date.parse(parsed.ts || '');
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
      }
      events.push(parsed);
    }
  }
  events.sort((a, b) => {
    const ta = Date.parse(a.ts || '') || 0;
    const tb = Date.parse(b.ts || '') || 0;
    return ta - tb;
  });
  if (limit && events.length > limit) return events.slice(-limit);
  return events;
}

// Parse duration strings like "15m", "2h", "1d", "30s" into milliseconds.
function parseDuration(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

export {
  recordEvent,
  tailEvents,
  fingerprint,
  parseDuration,
  logFile,
};
