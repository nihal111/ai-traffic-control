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
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] [${SLOT_NAME}] ${msg}\n`);

    // Keep log file under ~5MB
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > 5 * 1024 * 1024) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.split('\n');
      if (lines.length > 1000) {
        fs.writeFileSync(LOG_FILE, lines.slice(-1000).join('\n') + '\n', 'utf8');
      }
    }
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

/**
 * Parse a Claude/Gemini JSONL transcript and extract the last N
 * user/assistant text exchanges as clean readable text.
 * Filters out metadata lines (permission-mode, attachments, file-history, etc.)
 */
function readTranscriptExchanges(filePath, lineCount) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      // Only keep actual conversation messages
      const msg = obj.message || obj;
      const role = msg.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text)
          .join(' ');
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      messages.push({ role, text: truncate(text, 500) });
    }
    if (messages.length === 0) return '';
    // Take the last N messages and format as readable transcript
    const recent = messages.slice(-lineCount);
    return recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
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

function parseJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonPretty(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function prepareIsolatedGeminiHome(baseDir) {
  if (!HOME_DIR) return null;

  const sourceGeminiDir = path.join(HOME_DIR, '.gemini');
  if (!fs.existsSync(sourceGeminiDir)) return null;

  const isolatedHome = path.join(baseDir, 'home');
  const isolatedGeminiDir = path.join(isolatedHome, '.gemini');
  fs.mkdirSync(isolatedGeminiDir, { recursive: true });

  for (const name of ['oauth_creds.json', 'google_accounts.json', 'installation_id', 'state.json', 'projects.json', 'trustedFolders.json']) {
    const src = path.join(sourceGeminiDir, name);
    const dest = path.join(isolatedGeminiDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
  }

  const sourceSettings = parseJsonFile(path.join(sourceGeminiDir, 'settings.json')) || {};
  const isolatedSettings = {};
  if (sourceSettings.security && typeof sourceSettings.security === 'object') {
    isolatedSettings.security = sourceSettings.security;
  }
  writeJsonPretty(path.join(isolatedGeminiDir, 'settings.json'), isolatedSettings);
  return isolatedHome;
}

function writeJsonAtomic(filePath, payload) {
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, filePath);
}

function extractTitleFromStdout(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    if (rawLine === '```') continue;
    const line = rawLine.replace(/^title\s*:\s*/i, '').trim();
    if (!line) continue;
    const unquoted = line.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!unquoted) continue;
    return unquoted.length <= 60 ? unquoted : `${unquoted.slice(0, 59).trimEnd()}…`;
  }
  return '';
}

function updateSessionTitle(title) {
  if (!title) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state || typeof state !== 'object' || !state.sessions || typeof state.sessions !== 'object') {
      log('abort: state file missing sessions object');
      return false;
    }
    if (!state.sessions[SLOT_NAME] || typeof state.sessions[SLOT_NAME] !== 'object') {
      log(`abort: slot ${SLOT_NAME} missing from state file`);
      return false;
    }
    state.sessions[SLOT_NAME].taskTitle = title;
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(STATE_FILE, state);
    return true;
  } catch (error) {
    log(`failed to update state file: ${error.message}`);
    return false;
  }
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
const transcriptTail = transcriptPath ? readTranscriptExchanges(transcriptPath, TRANSCRIPT_LINE_COUNT) : '';
const transcriptSource = transcriptTail ? 'native_transcript' : 'events_fallback';
const transcriptContent = transcriptTail || transcript;
const tempTranscript = writeTempTranscript(transcriptContent);
const isolatedGeminiHome = prepareIsolatedGeminiHome(tempTranscript.dir);

log(`extracted ${exchanges.length} exchanges; source=${transcriptSource}; invoking gemini`);
if (isolatedGeminiHome) log(`prepared isolated gemini home at ${isolatedGeminiHome}`);

const instruction =
  `Read the transcript file ${path.basename(tempTranscript.file)} in the current directory. ` +
  `It contains the most recent interaction history for the "${SLOT_NAME}" coding session.\n\n` +
  `Return exactly one short title, max 60 characters, describing the current task. ` +
  `Do not use quotes, bullets, labels, markdown, code fences, or explanations. ` +
  `Output only the title text.`;

function runGeminiOnce(model) {
  return new Promise((resolve) => {
    const args = [];
    if (model) args.push('-m', model);
    args.push('-p', instruction, '--yolo', '--output-format', 'text');

    const child = spawn(SUMMARIZER_CMD, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: tempTranscript.dir,
      env: {
        ...process.env,
        ...(isolatedGeminiHome ? { HOME: isolatedGeminiHome, USERPROFILE: isolatedGeminiHome } : {}),
        ATC_NO_SUMMARIZER: '1',
        ATC_DISABLE_DASHBOARD_HOOKS: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    let closed = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      log(`timeout — killing gemini model=${model || 'default'}`);
      child.kill('SIGTERM');

      setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 4000);
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      closed = true;
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim(), spawnError: err.message });
    });

    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function isSystemResourceFailure(stderr) {
  const msg = String(stderr || '').toLowerCase();
  return msg.includes('too many open files') || msg.includes('kqueue():') || msg.includes('libuv');
}

function shouldRetryWithFallback(result) {
  const stderr = String(result?.stderr || '').toLowerCase();
  if (isSystemResourceFailure(stderr)) return true;
  return (
    stderr.includes('quota_exhausted') ||
    stderr.includes('quota exhausted') ||
    stderr.includes('exhausted your capacity') ||
    stderr.includes('rate limit') ||
    stderr.includes('resource_exhausted') ||
    stderr.includes('model not found') ||
    stderr.includes('unsupported model')
  );
}

const fallbackModel = 'gemini-2.5-flash-lite';
const attempts = [SUMMARIZER_MODEL];
if (SUMMARIZER_MODEL !== fallbackModel) attempts.push(fallbackModel);

let result = null;
for (const model of attempts) {
  if (result && result.code === 0) break;
  if (result && !shouldRetryWithFallback(result)) break;
  if (result) log(`retrying gemini with fallback model=${model}`);
  result = await runGeminiOnce(model);

  const firstLine = result.stdout.replace(/\s+/g, ' ').trim().split('\n')[0]?.trim() || '';
  log(`gemini exited code=${result.code} stdout_len=${result.stdout.length} stderr_len=${result.stderr.length} first_line="${firstLine}" model=${model}`);

  if (String(result.stderr || '').trim()) {
    let stderrPreview = String(result.stderr || '').trim().split('\n').slice(0, 5).join(' | ');
    // Filter out noisy keytar/keychain warnings
    stderrPreview = stderrPreview
      .replace(/Keychain initialization encountered an error:.*?Using FileKeychain fallback for secure storage\./g, '[keychain fallback active]')
      .trim();
    if (stderrPreview) {
      log(`gemini stderr: ${stderrPreview}`);
    }
  }

  if (result.code !== 0) {
    log(`gemini failed with exit code ${result.code} model=${model}`);
  }
}

const title = result && result.code === 0 ? extractTitleFromStdout(result.stdout) : '';
if (!title) {
  log('abort: summarizer did not return a usable title');
} else if (updateSessionTitle(title)) {
  log(`updated state title="${title}"`);
} else {
  log(`abort: failed to persist title="${title}"`);
}

try {
  fs.rmSync(tempTranscript.dir, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}
