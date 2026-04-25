import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { stripEsModuleExports, loadClientModuleSource } = await import(
  '../../modules/client-script-loader.mjs'
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_MODULES = path.join(__dirname, '..', '..', 'modules');

test('stripEsModuleExports removes trailing export-list statement', () => {
  const input = 'function foo() { return 1; }\nexport { foo };\n';
  const out = stripEsModuleExports(input);
  assert.ok(!/export/.test(out), `expected no export, got: ${out}`);
  assert.ok(out.includes('function foo'), 'function body preserved');
});

test('stripEsModuleExports removes multi-name export list', () => {
  const input = 'const a = 1;\nconst b = 2;\nexport { a, b };\n';
  const out = stripEsModuleExports(input);
  assert.ok(!/export/.test(out));
  assert.ok(out.includes('const a = 1'));
  assert.ok(out.includes('const b = 2'));
});

test('stripEsModuleExports handles export without trailing semicolon', () => {
  const input = 'function bar() {}\nexport { bar }\n';
  const out = stripEsModuleExports(input);
  assert.ok(!/export/.test(out));
});

test('stripEsModuleExports strips "export function" declaration prefix', () => {
  const input = 'export function hello() { return 42; }\n';
  const out = stripEsModuleExports(input);
  assert.equal(out.trim(), 'function hello() { return 42; }');
});

test('stripEsModuleExports strips "export async function" declaration prefix', () => {
  const input = 'export async function work() { await 1; }\n';
  const out = stripEsModuleExports(input);
  assert.equal(out.trim(), 'async function work() { await 1; }');
});

test('stripEsModuleExports strips "export const/let/var/class" prefixes', () => {
  const cases = [
    ['export const X = 1;', 'const X = 1;'],
    ['export let Y = 2;', 'let Y = 2;'],
    ['export var Z = 3;', 'var Z = 3;'],
    ['export class K {}', 'class K {}'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripEsModuleExports(input).trim(), expected);
  }
});

test('stripEsModuleExports strips "export default function"', () => {
  const input = 'export default function main() { return 1; }\n';
  const out = stripEsModuleExports(input);
  assert.equal(out.trim(), 'function main() { return 1; }');
});

test('stripEsModuleExports preserves non-export code untouched', () => {
  const input = 'const a = 1;\nfunction f() {\n  return "export";\n}\n';
  const out = stripEsModuleExports(input);
  assert.equal(out, input);
});

test('stripEsModuleExports does not mangle the word "export" inside strings', () => {
  const input = 'const label = "export these values";\nconst x = 1;\n';
  const out = stripEsModuleExports(input);
  assert.ok(out.includes('"export these values"'), 'string literal preserved');
});

test('stripEsModuleExports leaves indentation intact on stripped declarations', () => {
  const input = '  export const N = 5;\n';
  const out = stripEsModuleExports(input);
  assert.equal(out, '  const N = 5;\n');
});

test('loadClientModuleSource returns browser-safe profile-polling source', () => {
  const src = loadClientModuleSource(path.join(REPO_MODULES, 'profile-polling.mjs'));
  assert.ok(
    src.includes('async function pollUsageUntilProfileActive'),
    'function definition must be present',
  );
  assert.ok(!/^\s*export\b/m.test(src), 'no top-level export statements remain');
});

test('loadClientModuleSource output parses as valid JavaScript', () => {
  const src = loadClientModuleSource(path.join(REPO_MODULES, 'profile-polling.mjs'));
  // new Function will throw SyntaxError if the stripped source is malformed.
  // Wrap in an async IIFE placeholder so await-less function bodies parse.
  assert.doesNotThrow(() => new Function(src));
});
