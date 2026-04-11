#!/usr/bin/env node
/**
 * summarize-title.mjs — AI-powered session title summarizer
 *
 * Reads the last N exchanges from a slot's events.jsonl, builds a transcript,
 * and invokes Gemini CLI to update the session's taskTitle directly in the
 * sessions-state.json file.
 *
 * Invoked by shell-hook-writer.mjs every TRIGGER_INTERVAL user prompts.
 *
 * Configuration (env vars):
 *   ATC_SUMMARY_EXCHANGE_COUNT  — number of recent exchanges to include (default: 10)
 *   ATC_SUMMARY_TRANSCRIPT_LINES — number of transcript lines to pass to Gemini (default: 10)
 *   ATC_SUMMARIZER_MODEL        — Gemini model id for title summarization (default: gemini-3.1-flash-lite-preview)
 *   ATC_EVENTS_FILE             — path to the slot's events.jsonl
 *   ATC_SLOT                    — scientist name (e.g. "Feynman")
 *   ATC_STATE_FILE              — path to sessions-state.json
 *   ATC_SUMMARY_TIMEOUT_MS      — max time to wait for Gemini (default: 180000)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── Configuration ──────────────────────────────────────────────
const EXCHANGE_COUNT = Number(process.env.ATC_SUMMARY_EXCHANGE_COUNT || 10);
const TRANSCRIPT_LINE_COUNT = Number(process.env.ATC_SUMMARY_TRANSCRIPT_LINES || 10);
const TIMEOUT_MS = Number(process.env.ATC_SUMMARY_TIMEOUT_MS || 180000);
const EVENTS_FILE = process.env.ATC_EVENTS_FILE || '';
const SLOT_NAME = process.env.ATC_SLOT || '';
const STATE_FILE = process.env.ATC_STATE_FILE || '';
const SUMMARIZER_CMD = process.env.ATC_SUMMARIZER_CMD || 'gemini';
const SUMMARIZER_MODEL = String(process.env.ATC_SUMMARIZER_MODEL || 'gemini-3.1-flash-lite-preview').trim();

// ── Logging ────────────────────────────────────────────────────
const LOG_DIR = path.join(path.dirname(STATE_FILE || '.'), '..', 'runtime', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'summarizer.log');

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] [${SLOT_NAME}] ${msg}\n`);
  } catch { /* best-effort */ }
}

if (!EVENTS_FILE || !SLOT_NAME || !STATE_FILE) {
  log(`abort: missing env — EVENTS_FILE=${EVENTS_FILE} SLOT=${SLOT_NAME} STATE_FILE=${STATE_FILE}`);
  process.exit(0);
}

// ── Helpers ────────────────────────────────────────────────────

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractExchanges(events, count) {
  const userPrompts = [];
  const assistantReplies = [];

  for (const ev of events) {
    if ((ev.eventType === 'UserPromptSubmit' || ev.eventType === 'BeforeAgent') && ev.payload?.prompt) {
      userPrompts.push({ ts: ev.ts, text: ev.payload.prompt });
    }
    if (ev.eventType === 'Stop' && ev.payload?.last_assistant_message) {
      assistantReplies.push({ ts: ev.ts, text: ev.payload.last_assistant_message });
    }
    if (ev.eventType === 'AfterAgent' && ev.payload?.prompt_response) {
      assistantReplies.push({ ts: ev.ts, text: ev.payload.prompt_response });
    }
  }

  const recentPrompts = userPrompts.slice(-count);
  const exchanges = [];

  for (const prompt of recentPrompts) {
    const reply = assistantReplies.find((r) => r.ts >= prompt.ts);
    exchanges.push({
      user: truncate(prompt.text, 500),
      assistant: reply ? truncate(reply.text, 500) : null,
    });
  }

  return exchanges;
}

function truncate(text, maxLen) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen) + '…';
}

function extractLatestTranscriptPath(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i]?.payload?.transcript_path;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function readLastLines(filePath, lineCount) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    return lines.slice(-lineCount).join('\n').trim();
  } catch {
    return '';
  }
}

function writeTempTranscript(content) {
  const baseDir = path.join(path.dirname(STATE_FILE), '.tmp-summarizer');
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseDir, 'run-'));
  const file = path.join(dir, `last-${TRANSCRIPT_LINE_COUNT}-lines.txt`);
  fs.writeFileSync(file, content + '\n', 'utf8');
  return { dir, file };
}

// ── Main ───────────────────────────────────────────────────────

log('started');

const events = readJsonLines(EVENTS_FILE);
const exchanges = extractExchanges(events, EXCHANGE_COUNT);

if (exchanges.length === 0) {
  log('abort: no exchanges found');
  process.exit(0);
}

let transcript = '';
for (const ex of exchanges) {
  transcript += `User: ${ex.user}\n`;
  if (ex.assistant) {
    transcript += `Assistant: ${ex.assistant}\n`;
  }
  transcript += '\n';
}

const transcriptPath = extractLatestTranscriptPath(events);
const transcriptTail = transcriptPath ? readLastLines(transcriptPath, TRANSCRIPT_LINE_COUNT) : '';
const transcriptSource = transcriptTail ? 'native_transcript' : 'events_fallback';
const transcriptContent = transcriptTail || transcript;
const tempTranscript = writeTempTranscript(transcriptContent);

log(`extracted ${exchanges.length} exchanges; source=${transcriptSource}; invoking gemini`);

const instruction =
  `You are a helper that updates a session title in a JSON config file. ` +
  `Read the file ${tempTranscript.file} — it contains the most recent transcript lines ` +
  `for the "${SLOT_NAME}" coding session.\n\n` +
  `Based on this transcript, generate a short title (max 60 characters) that summarizes what the user is currently working on.\n\n` +
  `Then update the file ${STATE_FILE} — it is a JSON file with a "sessions" object. ` +
  `Find the key "${SLOT_NAME}" inside "sessions" and set its "taskTitle" field to your generated title. ` +
  `Do not change any other fields. Write the file back with the updated title.\n\n` +
  `After updating the file, output ONLY the title you chose (nothing else).`;

const summarizeArgs = [];
if (SUMMARIZER_MODEL) summarizeArgs.push('-m', SUMMARIZER_MODEL);
summarizeArgs.push('-p', instruction, '--yolo', '--output-format', 'text');

const child = spawn(SUMMARIZER_CMD, summarizeArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: path.dirname(STATE_FILE),
});

let stdout = '';
let stderr = '';
let closed = false;
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const timer = setTimeout(() => {
  log('timeout — killing gemini');
  child.kill('SIGTERM');

  setTimeout(() => {
    if (!closed) child.kill('SIGKILL');
  }, 4000);
}, TIMEOUT_MS);

child.on('error', (err) => {
  clearTimeout(timer);
  log(`spawn error: ${err.message}`);
});

child.on('close', (code) => {
  closed = true;
  clearTimeout(timer);

  const firstLine = stdout.replace(/\s+/g, ' ').trim().split('\n')[0]?.trim() || '';
  log(`gemini exited code=${code} stdout_len=${stdout.length} stderr_len=${stderr.length} first_line="${firstLine}"`);

  if (stderr.trim()) {
    // Log first few lines of stderr for debugging
    const stderrPreview = stderr.trim().split('\n').slice(0, 5).join(' | ');
    log(`gemini stderr: ${stderrPreview}`);
  }

  if (code !== 0) {
    log(`gemini failed with exit code ${code}`);
  }

  try {
    fs.unlinkSync(tempTranscript.file);
    fs.rmdirSync(tempTranscript.dir);
  } catch {
    // best-effort cleanup
  }
});
