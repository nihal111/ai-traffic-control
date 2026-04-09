#!/usr/bin/env node
/**
 * summarize-title.mjs — AI-powered session title summarizer
 *
 * Reads the last N exchanges from a slot's events.jsonl, builds a summarization
 * prompt, pipes it to a CLI agent (default: gemini), and writes the result to title.txt.
 *
 * Invoked by shell-hook-writer.mjs every TRIGGER_INTERVAL user prompts.
 *
 * Configuration (env vars):
 *   ATC_SUMMARY_EXCHANGE_COUNT  — number of recent exchanges to include (default: 10)
 *   ATC_SUMMARY_TRIGGER_INTERVAL — not used here; controls hook-side trigger cadence
 *   ATC_SUMMARIZER_CMD          — CLI command to run (default: "gemini")
 *   ATC_EVENTS_FILE             — path to the slot's events.jsonl
 *   ATC_CURRENT_DIR             — path to the slot's current/ directory (title.txt lives here)
 *   ATC_SUMMARY_TIMEOUT_MS      — max time to wait for the summarizer (default: 30000)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ── Configuration ──────────────────────────────────────────────
const EXCHANGE_COUNT = Number(process.env.ATC_SUMMARY_EXCHANGE_COUNT || 10);
const SUMMARIZER_CMD = process.env.ATC_SUMMARIZER_CMD || 'gemini';
const TIMEOUT_MS = Number(process.env.ATC_SUMMARY_TIMEOUT_MS || 30000);
const EVENTS_FILE = process.env.ATC_EVENTS_FILE || '';
const CURRENT_DIR = process.env.ATC_CURRENT_DIR || '';

if (!EVENTS_FILE || !CURRENT_DIR) {
  process.exit(0); // nothing to do
}

const TITLE_FILE = path.join(CURRENT_DIR, 'title.txt');
const META_FILE = path.join(CURRENT_DIR, 'meta.json');

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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function extractExchanges(events, count) {
  // Collect user prompts (UserPromptSubmit) and assistant replies (Stop)
  const userPrompts = [];
  const assistantReplies = [];

  for (const ev of events) {
    if (ev.eventType === 'UserPromptSubmit' && ev.payload?.prompt) {
      userPrompts.push({ ts: ev.ts, text: ev.payload.prompt });
    }
    if (ev.eventType === 'Stop' && ev.payload?.last_assistant_message) {
      assistantReplies.push({ ts: ev.ts, text: ev.payload.last_assistant_message });
    }
  }

  // Take the last N user prompts and pair with their corresponding replies
  const recentPrompts = userPrompts.slice(-count);
  const exchanges = [];

  for (const prompt of recentPrompts) {
    // Find the first assistant reply after this prompt
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

function buildPrompt(exchanges) {
  let conversation = '';
  for (const ex of exchanges) {
    conversation += `User: ${ex.user}\n`;
    if (ex.assistant) {
      conversation += `Assistant: ${ex.assistant}\n`;
    }
    conversation += '\n';
  }

  return (
    'Below is a transcript of recent interactions in a coding session. ' +
    'Generate a short title (max 60 characters) that summarizes what the user is currently working on. ' +
    'Output ONLY the title text, nothing else — no quotes, no explanation, no prefix.\n\n' +
    conversation
  );
}

// ── Main ───────────────────────────────────────────────────────

const events = readJsonLines(EVENTS_FILE);
const exchanges = extractExchanges(events, EXCHANGE_COUNT);

if (exchanges.length === 0) {
  process.exit(0);
}

// Write the exchanges to a temp file that the CLI agent can read with its tools.
// The instruction to summarize is passed as the short CLI argument; the transcript
// lives on disk so the agent can read it naturally without shell-escaping issues.
const tmpDir = os.tmpdir();
const transcriptFile = path.join(tmpDir, `atc-transcript-${process.pid}-${Date.now()}.md`);

let transcriptMd = '';
for (const ex of exchanges) {
  transcriptMd += `**User:** ${ex.user}\n\n`;
  if (ex.assistant) {
    transcriptMd += `**Assistant:** ${ex.assistant}\n\n`;
  }
  transcriptMd += '---\n\n';
}
fs.writeFileSync(transcriptFile, transcriptMd, 'utf8');

const instruction =
  `Read the file ${transcriptFile} — it contains recent exchanges from a coding session. ` +
  `Generate a short title (max 60 characters) that summarizes what the user is working on. ` +
  `Output ONLY the title text, nothing else.`;

const child = spawn(SUMMARIZER_CMD, [instruction], {
  stdio: ['ignore', 'pipe', 'ignore'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });

const timer = setTimeout(() => {
  child.kill('SIGTERM');
}, TIMEOUT_MS);

child.on('close', () => {
  clearTimeout(timer);

  // Clean up temp transcript file
  try { fs.unlinkSync(transcriptFile); } catch {}

  const title = output
    .replace(/\s+/g, ' ')
    .trim()
    .split('\n')[0]     // first line only
    .replace(/^["']|["']$/g, '') // strip surrounding quotes
    .trim()
    .slice(0, 80);

  if (!title) {
    process.exit(0);
  }

  // Write to title.txt
  fs.writeFileSync(TITLE_FILE, title + '\n', 'utf8');

  // Mark in meta that this was an AI-generated title
  const meta = readJson(META_FILE);
  meta.aiTitleAt = new Date().toISOString();
  meta.aiTitle = title;
  writeJsonAtomic(META_FILE, meta);
});
