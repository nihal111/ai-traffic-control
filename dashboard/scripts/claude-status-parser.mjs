#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = Number(process.env.ATC_CLAUDE_STATUS_TIMEOUT_MS || 25000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function stripAnsi(text) {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, '')
    .replace(/\r/g, '');
}

function runStatusRaw(timeoutMs) {
  const timeoutSec = Math.max(3, Math.ceil(timeoutMs / 1000));
  const script = `
    set timeout ${timeoutSec}
    log_user 1
    match_max 1048576
    spawn ${CLAUDE_BIN} --dangerously-skip-permissions
    after 1800
    send "/status\\r"
    after 1500
    send "\\033"
    after 400
    send "/exit\\r"
    after 500
    send "\\003"
    expect eof
  `;
  return execFileSync('expect', ['-c', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseStatus(raw) {
  const cleaned = stripAnsi(raw);
  const email = cleaned.match(/^\s*Email:\s*(.+?)\s*$/m)?.[1]?.trim() || null;
  const organization = cleaned.match(/^\s*Organization:\s*(.+?)\s*$/m)?.[1]?.trim() || null;
  const loginMethod = cleaned.match(/^\s*Login method:\s*(.+?)\s*$/m)?.[1]?.trim() || null;
  const model = cleaned.match(/^\s*Model:\s*(.+?)\s*$/m)?.[1]?.trim() || null;
  const version = cleaned.match(/^\s*Version:\s*(.+?)\s*$/m)?.[1]?.trim() || null;
  return { email, organization, loginMethod, model, version, raw: cleaned };
}

function parseArgs(argv) {
  const args = {
    json: false,
    raw: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--raw') args.raw = true;
    else if (token === '--timeout-ms' && argv[i + 1]) args.timeoutMs = Number(argv[++i]);
    else if (token === '-h' || token === '--help') {
      console.log(`claude-status-parser

Usage:
  node dashboard/scripts/claude-status-parser.mjs [--json] [--raw] [--timeout-ms <n>]

Description:
  Opens Claude in a PTY, runs /status, and parses active account metadata.
  This does not call /usage.
`);
      process.exit(0);
    } else {
      console.error(`Unknown option: ${token}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 3000) {
    console.error('Invalid --timeout-ms (must be >= 3000)');
    process.exit(1);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let rawOutput;
  try {
    rawOutput = runStatusRaw(args.timeoutMs);
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const merged = `${stdout}\n${stderr}`;
    const parsed = parseStatus(merged);
    if (parsed.email) {
      if (args.json) {
        console.log(JSON.stringify({
          email: parsed.email,
          organization: parsed.organization,
          loginMethod: parsed.loginMethod,
          model: parsed.model,
          version: parsed.version,
          checkedAt: new Date().toISOString(),
          degradedExit: true,
        }, null, 2));
      } else {
        console.log(`Email: ${parsed.email}`);
        if (parsed.organization) console.log(`Organization: ${parsed.organization}`);
        if (parsed.loginMethod) console.log(`Login method: ${parsed.loginMethod}`);
        if (parsed.model) console.log(`Model: ${parsed.model}`);
        if (parsed.version) console.log(`Version: ${parsed.version}`);
        console.log(`Checked at: ${new Date().toISOString()}`);
        console.log('Note: Claude exited slowly; parsed fields are from /status output.');
      }
      return;
    }
    const baseError = error?.message || 'failed to run Claude /status';
    const detail = parsed.email ? `parsed email=${parsed.email}` : 'no email parsed';
    console.error(`claude-status-parser failed: ${baseError}; ${detail}`);
    if (args.raw && merged) console.error(stripAnsi(merged));
    process.exit(1);
  }

  const parsed = parseStatus(rawOutput);
  if (!parsed.email) {
    console.error('claude-status-parser failed: could not parse Email from /status output');
    if (args.raw) console.error(parsed.raw);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({
      email: parsed.email,
      organization: parsed.organization,
      loginMethod: parsed.loginMethod,
      model: parsed.model,
      version: parsed.version,
      checkedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }

  console.log(`Email: ${parsed.email}`);
  if (parsed.organization) console.log(`Organization: ${parsed.organization}`);
  if (parsed.loginMethod) console.log(`Login method: ${parsed.loginMethod}`);
  if (parsed.model) console.log(`Model: ${parsed.model}`);
  if (parsed.version) console.log(`Version: ${parsed.version}`);
  console.log(`Checked at: ${new Date().toISOString()}`);
}

main();
