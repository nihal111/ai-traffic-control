#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureParent(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

const nowIso = new Date().toISOString();
const stdinEvent = readStdinJson();
const slot = process.env.ATC_SLOT || 'unknown';
const runId = process.env.ATC_RUN_ID || 'unknown';
const currentDir = process.env.ATC_CURRENT_DIR || '';
const fallbackEvents = currentDir ? path.join(currentDir, 'events.jsonl') : path.join(process.cwd(), 'dashboard', 'runtime', 'unassigned-events.jsonl');
const eventsFile = process.env.ATC_EVENTS_FILE || fallbackEvents;
const metaFile = process.env.ATC_META_FILE || (currentDir ? path.join(currentDir, 'meta.json') : path.join(process.cwd(), 'dashboard', 'runtime', 'meta-fallback.json'));
const derivedFile = process.env.ATC_DERIVED_FILE || (currentDir ? path.join(currentDir, 'derived.json') : path.join(process.cwd(), 'dashboard', 'runtime', 'derived-fallback.json'));

const rawDuration = process.env.ATC_EVENT_DURATION_MS;
const durationMs = rawDuration === undefined || rawDuration === '' ? null : Number(rawDuration);
const stdinDurationMs = Number.isFinite(Number(stdinEvent?.durationMs)) ? Number(stdinEvent.durationMs) : null;

const eventType = process.env.ATC_EVENT_TYPE || stdinEvent?.eventType || stdinEvent?.type || 'unknown';
const cwd = process.env.ATC_EVENT_CWD || stdinEvent?.cwd || stdinEvent?.workdir || null;
const command = process.env.ATC_EVENT_COMMAND || stdinEvent?.command || stdinEvent?.input || null;

const event = {
  ts: nowIso,
  slot,
  runId,
  eventType,
  cwd,
  command,
  durationMs: Number.isFinite(durationMs) ? durationMs : stdinDurationMs,
  payload: stdinEvent || null,
};

ensureParent(eventsFile);
fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n', 'utf8');

const meta = readJson(metaFile, {});
const eventCount = Number(meta.eventCount || 0) + 1;

const nextMeta = {
  ...meta,
  slot,
  runId,
  activeSince: meta.activeSince || nowIso,
  lastInteractionAt: nowIso,
  cwd: event.cwd || meta.cwd || null,
  lastEventType: event.eventType,
  eventCount,
};

if (event.command) {
  nextMeta.lastCommand = event.command;
  nextMeta.lastCommandAt = nowIso;
}
if (event.durationMs !== null) nextMeta.lastDurationMs = event.durationMs;
if (event.eventType === 'shell_start') nextMeta.shellStartedAt = nowIso;

writeJsonAtomic(metaFile, nextMeta);

const nextDerived = {
  slot,
  runId,
  activeSince: nextMeta.activeSince,
  lastInteractionAt: nextMeta.lastInteractionAt,
  cwd: nextMeta.cwd,
  lastEventType: nextMeta.lastEventType,
  eventCount: nextMeta.eventCount,
  shellStartedAt: nextMeta.shellStartedAt || null,
  lastCommand: nextMeta.lastCommand || null,
  lastCommandAt: nextMeta.lastCommandAt || null,
  durationMs: nextMeta.lastDurationMs ?? null,
};

writeJsonAtomic(derivedFile, nextDerived);
