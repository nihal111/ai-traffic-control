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
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.dirname(MODULE_DIR);

// Resolve the log file at call time, not module load, so tests overriding
// ATC_DASHBOARD_RUNTIME_DIR after import pick up the intended path. The
// fallback is anchored to the module's own location so it stays correct
// regardless of process.cwd() — relying on cwd produced doubled paths
// like dashboard/dashboard/runtime/ when the dashboard launched with
// cwd=dashboard/.
function defaultLogDir() {
  return path.join(
    process.env.ATC_DASHBOARD_RUNTIME_DIR ||
      path.join(DASHBOARD_DIR, 'runtime'),
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
  // Trace correlation: promote any operation-specific ID to `trace_id` so a
  // single grep by trace_id surfaces the full timeline regardless of which
  // flow originated the event. `trace_id` wins if explicitly set; otherwise
  // we pick the first present ID from (switch_id, rotate_id, add_id).
  if (!payload.trace_id || payload.trace_id === null) {
    payload.trace_id = payload.switch_id || payload.rotate_id || payload.add_id || null;
  }
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

// Generate a trace ID used to correlate every event in one logical operation
// (one `rotate`, one `switch`, one `add`, one sync-daemon cycle). Callers
// generate once at the entry point and thread the same value down through
// every event they emit. The `diagnose` CLI greps by this.
function generateTraceId() {
  return randomUUID();
}

// Filter a tailed event list to events that share any of the supplied
// correlation IDs (trace_id, switch_id, rotate_id, add_id). Useful for
// `atc-profile diagnose --trace <id>`: the id the user has in hand may have
// come from any of those fields, so we accept all and match any.
function filterEventsByTrace(events, id) {
  const needle = String(id || '').trim();
  if (!needle) return [];
  const fields = ['trace_id', 'switch_id', 'rotate_id', 'add_id'];
  return events.filter((ev) => fields.some((f) => ev && ev[f] === needle));
}

export {
  recordEvent,
  tailEvents,
  fingerprint,
  parseDuration,
  logFile,
  generateTraceId,
  filterEventsByTrace,
};
