import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WRITER = path.resolve(__dirname, '../../scripts/shell-hook-writer.mjs');
const FORWARDER = path.resolve(__dirname, '../../scripts/codex-hook-forwarder.mjs');

async function runHook(eventType, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORWARDER], {
      env: {
        ...process.env,
        ATC_NO_SUMMARIZER: '1',
        ATC_PROVIDER: 'gemini',
        ...env,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`hook exited with ${code}: ${stderr}`));
      }
    });

    child.stdin.write(JSON.stringify({
      hook_event_name: eventType,
      ...payload
    }));
    child.stdin.end();
  });
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

test('Gemini hooks (BeforeAgent) should increment userPromptCount and trigger summarization logic', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atc-gemini-hook-test-'));
  const eventsFile = path.join(tmp, 'events.jsonl');
  const metaFile = path.join(tmp, 'meta.json');
  const derivedFile = path.join(tmp, 'derived.json');

  const env = {
    ATC_SLOT: 'Einstein',
    ATC_RUN_ID: 'run-gemini-1',
    ATC_EVENTS_FILE: eventsFile,
    ATC_META_FILE: metaFile,
    ATC_DERIVED_FILE: derivedFile,
    ATC_CURRENT_DIR: tmp,
  };

  // 1. SessionStart
  await runHook('SessionStart', { source: 'startup' }, env);

  let meta = await readJson(metaFile);
  assert.equal(meta.lastEventType, 'SessionStart');
  assert.equal(meta.userPromptCount || 0, 0);

  // 2. BeforeAgent (The user prompt in Gemini)
  await runHook('BeforeAgent', { prompt: 'Who are you?' }, env);

  meta = await readJson(metaFile);
  assert.equal(meta.lastEventType, 'BeforeAgent');
  // This is expected to fail initially because shell-hook-writer.mjs doesn't know BeforeAgent yet.
  assert.equal(meta.userPromptCount, 1, 'BeforeAgent should increment userPromptCount');

  // 3. AfterAgent (The assistant response in Gemini)
  await runHook('AfterAgent', { prompt_response: 'I am Einstein.' }, env);

  meta = await readJson(metaFile);
  assert.equal(meta.lastEventType, 'AfterAgent');

  const lines = (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean);
  const lastEvent = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastEvent.eventType, 'AfterAgent');
  assert.equal(lastEvent.payload.prompt_response, 'I am Einstein.');

  await fs.rm(tmp, { recursive: true, force: true });
});
