import { beforeEach, expect, it, vi } from 'vitest';
import type { EventLaunchClaim } from '@/backend/services/agent-definition';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createEventLaunchResources } from './event-run-resources.orchestrator';

const ports = vi.hoisted(() => ({
  binding: vi.fn(),
  freeze: vi.fn(),
  workspace: vi.fn(),
  session: vi.fn(),
  settings: vi.fn(),
  reserve: vi.fn(),
}));
vi.mock('@/backend/services/agent-definition', () => ({
  readEventExecutionBinding: ports.binding,
  freezeEventExecution: ports.freeze,
}));
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: { withAccountReservation: ports.reserve },
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: ports.settings } }));
vi.mock('@/backend/services/session', () => ({
  sessionDataService: { createEventSessionOnce: ports.session },
}));
vi.mock('@/backend/services/workspace', () => ({
  WorkspaceCreationService: class {
    createEventWorkspaceOnce = ports.workspace;
  },
}));
const claim: EventLaunchClaim = {
  status: 'CLAIMED',
  runId: 'run',
  workerGeneration: 1,
  attemptGeneration: 1,
  reservedWorkspaceId: 'workspace',
  reservedSessionId: 'session',
  initialMessageId: 'message',
};
const run = (provider: 'CLAUDE' | 'CODEX') =>
  unsafeCoerce<Parameters<typeof createEventLaunchResources>[1]>({
    projectId: 'project',
    definition: { name: 'Event agent' },
    execution: { version: 1, provider, model: provider === 'CLAUDE' ? 'sonnet' : 'gpt-5.4' },
    input: {},
  });
beforeEach(() => {
  vi.resetAllMocks();
  ports.binding.mockResolvedValue({ messageId: 'message', sendAttemptId: 'attempt' });
  ports.settings.mockResolvedValue({ defaultWorkspacePermissions: 'STRICT' });
  ports.reserve.mockImplementation(async (_options, create) => create('account'));
});

it.each([
  ['CLAUDE', 'STRICT', 'default'],
  ['CLAUDE', 'RELAXED', 'auto'],
  ['CLAUDE', 'YOLO', 'bypassPermissions'],
  ['CODEX', 'STRICT', 'workspace-write'],
  ['CODEX', 'RELAXED', 'agent'],
  ['CODEX', 'YOLO', 'agent-full-access'],
] as const)(
  'freezes %s %s access without granting incidental unattended privileges',
  async (provider, preset, accessMode) => {
    ports.settings.mockResolvedValue({
      defaultWorkspacePermissions: 'YOLO',
      automationPermissions: preset,
    });
    await createEventLaunchResources(claim, run(provider), vi.fn());
    const execution = ports.freeze.mock.calls[0]?.[0].execution;
    expect(execution).toMatchObject({
      provider,
      accessMode,
      startupModePreset: 'non_interactive',
      planModeEnabled: false,
      codexAccountId: provider === 'CODEX' ? 'account' : null,
    });
    expect(ports.workspace).toHaveBeenCalledWith(expect.objectContaining({ execution }));
    expect(ports.session).toHaveBeenCalledWith(expect.objectContaining({ execution }));
  }
);

it('recovers the frozen permission intent without rereading mutable defaults or reserving an account', async () => {
  const execution: EventAgentExecution = {
    version: 1,
    provider: 'CODEX',
    turnLimitMinutes: 120,
    model: 'gpt-5.4',
    reasoningEffort: null,
    codexAccountId: 'original-account',
    startupModePreset: 'non_interactive',
    accessMode: 'workspace-write',
    planModeEnabled: false,
  };
  ports.binding.mockResolvedValue({ execution, messageId: 'message', sendAttemptId: 'attempt' });
  ports.settings.mockRejectedValue(new Error('Settings unavailable'));
  await createEventLaunchResources(claim, run('CODEX'), vi.fn());
  expect(ports.settings).not.toHaveBeenCalled();
  expect(ports.reserve).not.toHaveBeenCalled();
  expect(ports.freeze).toHaveBeenCalledWith(expect.objectContaining({ execution }));
  expect(ports.session).toHaveBeenCalledWith(expect.objectContaining({ execution }));
});

it('does not create resources if workspace permissions cannot be read', async () => {
  ports.settings.mockRejectedValue(new Error('Settings unavailable'));
  await expect(createEventLaunchResources(claim, run('CLAUDE'), vi.fn())).rejects.toThrow(
    'Settings unavailable'
  );
  expect(ports.freeze).not.toHaveBeenCalled();
  expect(ports.workspace).not.toHaveBeenCalled();
  expect(ports.session).not.toHaveBeenCalled();
});

it.each(['CLAUDE', 'CODEX'] as const)(
  'defaults new %s executions to auto review',
  async (provider) => {
    ports.settings.mockResolvedValue({ defaultWorkspacePermissions: 'YOLO' });
    await createEventLaunchResources(claim, run(provider), vi.fn());
    expect(ports.freeze.mock.calls[0]?.[0].execution.accessMode).toBe(
      provider === 'CODEX' ? 'agent' : 'auto'
    );
  }
);

it.each(['CLAUDE', 'CODEX'] as const)(
  'freezes the selected turn limit for %s resources',
  async (provider) => {
    for (const [settings, expected] of [
      [{ turnLimitMinutes: 120 }, 120],
      [{ turnLimitMinutes: null }, null],
      [{}, null],
    ] as const) {
      ports.settings.mockResolvedValue(settings);
      await createEventLaunchResources(claim, run(provider), vi.fn());
      const execution = ports.freeze.mock.lastCall?.[0].execution;
      expect(execution).toMatchObject({ provider, turnLimitMinutes: expected });
      expect(ports.workspace).toHaveBeenLastCalledWith(expect.objectContaining({ execution }));
      expect(ports.session).toHaveBeenLastCalledWith(expect.objectContaining({ execution }));
    }
  }
);
