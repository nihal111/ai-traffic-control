import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENABLE_SCRIPT = path.resolve(__dirname, '../../scripts/enable-codex-hooks.sh');

test('enable-codex-hooks.sh should configure Gemini hooks correctly', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'atc-home-test-'));
  
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [ENABLE_SCRIPT], {
      env: {
        ...process.env,
        HOME: tmpHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`enable script exited with ${code}: ${stderr}`));
    });
  });

  const geminiSettingsPath = path.join(tmpHome, '.gemini', 'settings.json');
  const exists = await fs.access(geminiSettingsPath).then(() => true).catch(() => false);
  assert.ok(exists, 'Gemini settings file should be created');

  const settings = JSON.parse(await fs.readFile(geminiSettingsPath, 'utf8'));
  assert.ok(settings.hooks, 'hooks object should exist');
  assert.ok(settings.hooks.SessionStart, 'SessionStart hook should exist');
  assert.ok(settings.hooks.BeforeAgent, 'BeforeAgent hook should exist');
  assert.ok(settings.hooks.SessionEnd, 'SessionEnd hook should exist');
  
  assert.equal(settings.hooks.BeforeAgent[0].matcher, '*');
  assert.equal(settings.hooks.BeforeAgent[0].hooks[0].type, 'command');
  assert.ok(settings.hooks.BeforeAgent[0].hooks[0].command.includes('ATC_PROVIDER=gemini'));
  
  assert.equal(settings.hooksConfig.enabled, true, 'hooksConfig.enabled should be true');

  await fs.rm(tmpHome, { recursive: true, force: true });
});
