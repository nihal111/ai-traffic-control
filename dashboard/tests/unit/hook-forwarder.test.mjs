import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FORWARDER = path.resolve(__dirname, '../../scripts/codex-hook-forwarder.mjs');

function runForwarder({ env = {}, stdin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORWARDER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`forwarder exited with ${code}: ${stderr}`));
      }
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

test('codex hook forwarder no-ops when dashboard hooks are disabled', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atc-hook-forwarder-test-'));
  const eventsFile = path.join(tmp, 'events.jsonl');
  const metaFile = path.join(tmp, 'meta.json');
  const derivedFile = path.join(tmp, 'derived.json');

  const result = await runForwarder({
    env: {
      ATC_DISABLE_DASHBOARD_HOOKS: '1',
      ATC_SLOT: 'Feynman',
      ATC_RUN_ID: 'run-hook-disabled',
      ATC_EVENTS_FILE: eventsFile,
      ATC_META_FILE: metaFile,
      ATC_DERIVED_FILE: derivedFile,
      ATC_EVENT_TYPE: 'BeforeAgent',
    },
    stdin: JSON.stringify({
      hook_event_name: 'BeforeAgent',
      prompt: 'Summarize this session title',
    }),
  });

  assert.equal(result.stdout.trim(), '{}');

  const eventsExists = await fs.access(eventsFile).then(() => true).catch(() => false);
  const metaExists = await fs.access(metaFile).then(() => true).catch(() => false);
  const derivedExists = await fs.access(derivedFile).then(() => true).catch(() => false);
  assert.equal(eventsExists, false);
  assert.equal(metaExists, false);
  assert.equal(derivedExists, false);

  await fs.rm(tmp, { recursive: true, force: true });
});
