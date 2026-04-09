#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── Summarizer trigger config ──────────────────────────────────
const SUMMARY_TRIGGER_INTERVAL = Number(process.env.ATC_SUMMARY_TRIGGER_INTERVAL || 5);
const SUMMARIZER_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'summarize-title.mjs');

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseJsonObject(raw) || fallback;
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
    const stat = fs.fstatSync(0);
    // Hook calls from interactive shells inherit a TTY stdin; reading fd 0 in that
    // case blocks forever and freezes the terminal. Only read stdin for piped input.
    if (stat.isCharacterDevice()) return null;
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return null;
    return parseJsonObject(raw);
  } catch {
    return null;
  }
}

function resolveOutputFiles(currentDir) {
  const fallbackRoot = path.join(process.cwd(), 'dashboard', 'runtime');
  const fallbackEvents = currentDir ? path.join(currentDir, 'events.jsonl') : path.join(fallbackRoot, 'unassigned-events.jsonl');
  return {
    eventsFile: process.env.ATC_EVENTS_FILE || fallbackEvents,
    metaFile: process.env.ATC_META_FILE || (currentDir ? path.join(currentDir, 'meta.json') : path.join(fallbackRoot, 'meta-fallback.json')),
    derivedFile: process.env.ATC_DERIVED_FILE || (currentDir ? path.join(currentDir, 'derived.json') : path.join(fallbackRoot, 'derived-fallback.json')),
  };
}

function buildEvent({ nowIso, stdinEvent, slot, runId, provider }) {
  const rawDuration = process.env.ATC_EVENT_DURATION_MS;
  const durationMs = rawDuration === undefined || rawDuration === '' ? null : Number(rawDuration);
  const stdinDurationMs = Number.isFinite(Number(stdinEvent?.durationMs)) ? Number(stdinEvent.durationMs) : null;
  const eventType = process.env.ATC_EVENT_TYPE || stdinEvent?.hook_event_name || stdinEvent?.hookEventName || stdinEvent?.eventType || stdinEvent?.type || 'unknown';
  const cwd = process.env.ATC_EVENT_CWD || stdinEvent?.cwd || stdinEvent?.workdir || null;
  const command =
    process.env.ATC_EVENT_COMMAND ||
    stdinEvent?.command ||
    stdinEvent?.input ||
    stdinEvent?.tool_input?.command ||
    null;

  return {
    ts: nowIso,
    slot,
    runId,
    provider,
    eventType,
    cwd,
    command,
    durationMs: Number.isFinite(durationMs) ? durationMs : stdinDurationMs,
    payload: stdinEvent || null,
  };
}

const nowIso = new Date().toISOString();
const stdinEvent = readStdinJson();
const slot = process.env.ATC_SLOT || 'unknown';
const runId = process.env.ATC_RUN_ID || 'unknown';
const provider = process.env.ATC_PROVIDER || stdinEvent?.provider || null;
const currentDir = process.env.ATC_CURRENT_DIR || '';
const { eventsFile, metaFile, derivedFile } = resolveOutputFiles(currentDir);
const event = buildEvent({ nowIso, stdinEvent, slot, runId, provider });

ensureParent(eventsFile);
fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n', 'utf8');

const meta = readJson(metaFile, {});
const eventCount = Number(meta.eventCount || 0) + 1;

const nextMeta = {
  ...meta,
  slot,
  runId,
  provider,
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

// Track user prompt count separately for summarizer trigger
const isUserPrompt = event.eventType === 'UserPromptSubmit';
if (isUserPrompt) {
  nextMeta.userPromptCount = Number(nextMeta.userPromptCount || 0) + 1;
}

writeJsonAtomic(metaFile, nextMeta);

const nextDerived = {
  slot,
  runId,
  provider,
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

// ── Trigger AI title summarizer on 1st prompt, then every N after ──
// Fires at userPromptCount: 1, 1+N, 1+2N, ... (i.e. 1, 6, 11, 16 for N=5)
const shouldSummarize =
  isUserPrompt &&
  nextMeta.userPromptCount > 0 &&
  (nextMeta.userPromptCount === 1 || (nextMeta.userPromptCount - 1) % SUMMARY_TRIGGER_INTERVAL === 0);

if (
  shouldSummarize &&
  currentDir &&
  fs.existsSync(SUMMARIZER_SCRIPT)
) {
  const child = spawn(process.execPath, [SUMMARIZER_SCRIPT], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      ATC_EVENTS_FILE: eventsFile,
      ATC_CURRENT_DIR: currentDir,
    },
  });
  child.unref();
}
