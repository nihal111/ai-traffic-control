import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_TEST_IMPORT = '1';
const {
  buildProviderLaunchCommand,
  normalizePersonaId,
  normalizePersonaForTemplate,
  personaConfig,
  personaIdsForTemplate,
} = await import('../../server.mjs');

test('persona aliases normalize to the new slot machine bandit id', () => {
  assert.equal(normalizePersonaId('lucky_dip_explorer'), 'slot_machine_bandit');
  assert.equal(normalizePersonaId('Slot Machine Bandit'), 'slot_machine_bandit');
  assert.equal(personaConfig('slot_machine_bandit').label, 'Slot Machine Bandit');
  assert.deepEqual(personaIdsForTemplate('new_brainstorm'), ['none', 'brainstormer']);
  assert.deepEqual(personaIdsForTemplate('continue_work'), ['none', 'refactor', 'tester', 'reviewer', 'slot_machine_bandit', 'documenter']);
  assert.equal(normalizePersonaForTemplate('tester', 'new_brainstorm'), 'none');
  assert.equal(normalizePersonaForTemplate('tester', 'continue_work'), 'tester');
});

test('provider launch command seeds prompt from a persona file path', () => {
  const command = buildProviderLaunchCommand('codex', '/tmp/workspace', '/tmp/personas/refactor.md');

  assert.match(command, /cd '\/tmp\/workspace' && codex --dangerously-bypass-approvals-and-sandbox/);
  assert.match(command, /\$\(cat '\/tmp\/personas\/refactor\.md'\)/);
  assert.doesNotMatch(command, /node -e/);
  assert.doesNotMatch(command, /base64/);
});
