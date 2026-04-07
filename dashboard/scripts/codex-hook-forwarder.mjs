#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const writerPath = path.join(__dirname, 'shell-hook-writer.mjs');

async function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

function parseJson(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

function forwardToWriter(raw, eventType) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [writerPath], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        ...process.env,
        ATC_EVENT_TYPE: eventType,
      },
    });

    child.on('error', () => resolve());
    child.on('close', () => resolve());

    if (raw && raw.length > 0) {
      child.stdin.write(raw);
    }
    child.stdin.end();
  });
}

const raw = await readStdin();
const payload = parseJson(raw);
const eventType = payload?.hook_event_name || payload?.hookEventName || process.env.ATC_EVENT_TYPE || 'CodexHook';

await forwardToWriter(raw, eventType);

if (eventType === 'Stop') {
  process.stdout.write('{"continue": true}\n');
}
