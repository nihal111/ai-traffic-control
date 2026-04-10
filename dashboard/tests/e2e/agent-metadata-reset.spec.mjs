import { test, expect } from '@playwright/test';
import { DashboardHarness, waitFor } from './harness.mjs';

const DASHBOARD_PORT = 19120;
const BACKEND_PORT = 18130;
const PUBLIC_PORT = 17130;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

test.beforeAll(async () => {
  await harness.setup('AgentMeta');
});

test.afterAll(async () => {
  await harness.teardown();
});

test('agent metadata resets after killing hot-dial session then spawning vanilla', async () => {
  await harness.api('/api/agents/spawn', 'POST', {
    dialId: 'calendar_manager',
    provider: 'codex',
  });

  await waitFor(async () => {
    const session = await harness.getSession();
    return session && session.backendActive;
  }, 12000);

  let session = await harness.getSession();
  expect(session.agentType).toBe('calendar_manager');
  expect(String(session.taskTitle || '')).toContain('Calendar Manager');

  await harness.api('/api/sessions/kill', 'POST', { name: harness.slotName });

  await waitFor(async () => {
    const s = await harness.getSession();
    return s && s.status === 'idle' && !s.backendActive;
  }, 12000);

  session = await harness.getSession();
  expect(session.agentType).toBe('none');

  await harness.api('/api/sessions/spawn', 'POST', {
    name: harness.slotName,
    provider: 'codex',
    templateId: 'new_brainstorm',
    personaId: 'none',
  });

  await waitFor(async () => {
    const s = await harness.getSession();
    return s && s.backendActive;
  }, 12000);

  session = await harness.getSession();
  expect(session.agentType).toBe('none');
  expect(String(session.taskTitle || '')).not.toContain('Calendar Manager');
});
