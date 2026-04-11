import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUMMARIZER = path.resolve(__dirname, '../../scripts/summarize-title.mjs');

function runSummarizer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUMMARIZER], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
        reject(new Error(`summarizer exited with ${code}: ${stderr}`));
      }
    });
  });
}

test('summarize-title updates only the target session title from summarizer stdout', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atc-summarize-title-'));
  const stateDir = path.join(tmp, 'state');
  const runtimeDir = path.join(tmp, 'runtime');
  const eventsFile = path.join(runtimeDir, 'events.jsonl');
  const stateFile = path.join(stateDir, 'sessions-state.json');
  const fakeCmd = path.join(tmp, 'fake-gemini.sh');
  const markerFile = path.join(tmp, 'cwd.txt');

  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      updatedAt: '2026-04-11T00:00:00.000Z',
      sessions: {
        Feynman: { name: 'Feynman', taskTitle: 'Old title' },
        Einstein: { name: 'Einstein', taskTitle: 'Keep me' },
      },
    }, null, 2) + '\n',
    'utf8'
  );
  await fs.writeFile(
    eventsFile,
    [
      JSON.stringify({
        ts: '2026-04-11T00:00:00.000Z',
        eventType: 'UserPromptSubmit',
        payload: { prompt: 'Investigate flaky session state behavior' },
      }),
      JSON.stringify({
        ts: '2026-04-11T00:00:01.000Z',
        eventType: 'Stop',
        payload: { last_assistant_message: 'I will inspect the dashboard session state pipeline.' },
      }),
    ].join('\n') + '\n',
    'utf8'
  );
  await fs.writeFile(
    fakeCmd,
    `#!/bin/sh
pwd > "$MARKER_FILE"
printf 'Session state debugging title\\n'
`,
    { mode: 0o755 }
  );

  await runSummarizer({
    ATC_EVENTS_FILE: eventsFile,
    ATC_SLOT: 'Feynman',
    ATC_STATE_FILE: stateFile,
    ATC_SUMMARIZER_CMD: fakeCmd,
    ATC_SUMMARIZER_MODEL: '',
    MARKER_FILE: markerFile,
    ATC_SUMMARY_TIMEOUT_MS: '5000',
  });

  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(state.sessions.Feynman.taskTitle, 'Session state debugging title');
  assert.equal(state.sessions.Einstein.taskTitle, 'Keep me');

  const cwdUsed = (await fs.readFile(markerFile, 'utf8')).trim();
  assert.match(cwdUsed, /\.tmp-summarizer\/run-/);

  await fs.rm(tmp, { recursive: true, force: true });
});
