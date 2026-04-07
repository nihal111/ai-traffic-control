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

function runWriter({ env = {}, stdin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER], {
      env: { ...process.env, ...env },
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
        reject(new Error(`writer exited with ${code}: ${stderr}`));
      }
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

test('shell hook writer appends events and updates meta/derived files', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atc-shell-hook-test-'));
  const eventsFile = path.join(tmp, 'events.jsonl');
  const metaFile = path.join(tmp, 'meta.json');
  const derivedFile = path.join(tmp, 'derived.json');

  await runWriter({
    env: {
      ATC_SLOT: 'Feynman',
      ATC_RUN_ID: 'run-1',
      ATC_EVENTS_FILE: eventsFile,
      ATC_META_FILE: metaFile,
      ATC_DERIVED_FILE: derivedFile,
      ATC_EVENT_TYPE: 'preexec',
      ATC_EVENT_CWD: '/tmp/work',
      ATC_EVENT_COMMAND: 'echo hello',
      ATC_EVENT_DURATION_MS: '42',
    },
  });

  const lines = (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const first = JSON.parse(lines[0]);
  assert.equal(first.slot, 'Feynman');
  assert.equal(first.runId, 'run-1');
  assert.equal(first.eventType, 'preexec');
  assert.equal(first.cwd, '/tmp/work');
  assert.equal(first.command, 'echo hello');
  assert.equal(first.durationMs, 42);

  const meta1 = await readJson(metaFile);
  assert.equal(meta1.slot, 'Feynman');
  assert.equal(meta1.runId, 'run-1');
  assert.equal(meta1.eventCount, 1);
  assert.equal(meta1.lastEventType, 'preexec');
  assert.equal(meta1.lastCommand, 'echo hello');

  const derived1 = await readJson(derivedFile);
  assert.equal(derived1.eventCount, 1);
  assert.equal(derived1.lastEventType, 'preexec');
  assert.equal(derived1.lastCommand, 'echo hello');
  assert.equal(derived1.durationMs, 42);

  await runWriter({
    env: {
      ATC_SLOT: 'Feynman',
      ATC_RUN_ID: 'run-1',
      ATC_EVENTS_FILE: eventsFile,
      ATC_META_FILE: metaFile,
      ATC_DERIVED_FILE: derivedFile,
    },
    stdin: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/work/subdir',
      command: 'codex run',
      provider: 'codex',
      durationMs: 88,
    }),
  });

  const lines2 = (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines2.length, 2);
  const second = JSON.parse(lines2[1]);
  assert.equal(second.eventType, 'UserPromptSubmit');
  assert.equal(second.provider, 'codex');
  assert.equal(second.cwd, '/tmp/work/subdir');
  assert.equal(second.durationMs, 88);

  const meta2 = await readJson(metaFile);
  assert.equal(meta2.eventCount, 2);
  assert.equal(meta2.provider, 'codex');
  assert.equal(meta2.cwd, '/tmp/work/subdir');
  assert.equal(meta2.lastEventType, 'UserPromptSubmit');

  const derived2 = await readJson(derivedFile);
  assert.equal(derived2.eventCount, 2);
  assert.equal(derived2.provider, 'codex');
  assert.equal(derived2.cwd, '/tmp/work/subdir');
  assert.equal(derived2.lastEventType, 'UserPromptSubmit');

  await fs.rm(tmp, { recursive: true, force: true });
});
