import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { SessionQueuedSettings } from '@/backend/services/session/service/lifecycle/session-queued-settings';

const identities = [
  { id: 'thought_level' },
  { id: 'effort', category: 'reasoning' },
  { id: 'reasoning_effort' },
  { id: 'effort', category: 'thought_level' },
];
function fixture() {
  const handle = createTestProcessHandle({ provider: 'CODEX' });
  const queued = new SessionQueuedSettings({ getClient: () => handle });
  const message = {
    timestamp: new Date(0).toISOString(),
    settings: {
      selectedModel: null,
      reasoningEffort: 'high',
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  return { handle, queued, message };
}
function reasoning(identity: { id: string; category?: string }): SessionConfigOption {
  return {
    ...identity,
    name: 'Reasoning',
    type: 'select',
    currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }],
  };
}

describe('queued explicit settings', () => {
  it.each(identities)('captures reasoning identified by %j', async (identity) => {
    const f = fixture();
    f.handle.configOptions = [reasoning(identity)];
    await f.queued.capture('session', identity.id, async () => undefined)();
    expect(f.queued.resolve('session', f.message).reasoningEffort).toBe('low');
  });

  it.each(identities)(
    'captures reasoning normalization after a model edit for %j',
    async (identity) => {
      const f = fixture();
      f.handle.configOptions = [
        {
          id: 'model',
          category: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'second',
          options: [{ value: 'second', name: 'Second' }],
        },
        reasoning(identity),
      ];
      await f.queued.capture('session', 'model', async () => undefined)();
      expect(f.queued.resolve('session', f.message)).toMatchObject({
        selectedModel: 'second',
        reasoningEffort: 'low',
      });
    }
  );

  it.each(identities)('captures the semantic reasoning alias for %j', async (identity) => {
    const f = fixture();
    f.handle.configOptions = [reasoning(identity)];
    await f.queued.capture('session', 'thought_level', async () => undefined)();
    expect(f.queued.resolve('session', f.message).reasoningEffort).toBe('low');
  });

  it('preserves confirmed startup planning when queued false has no explicit intent', async () => {
    const f = fixture();
    f.handle.configOptions = [
      {
        id: 'collaboration_mode',
        name: 'Planning',
        type: 'select',
        currentValue: 'plan',
        options: [{ value: 'plan', name: 'Plan' }],
      },
    ];
    const plan = vi.fn(async () => undefined);
    await f.queued.configure('session', f.message, false, {
      plan,
      model: async () => undefined,
      reasoning: async () => undefined,
      thinking: async () => undefined,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(f.handle.configOptions[0]?.currentValue).toBe('plan');
  });

  it('keeps explicit native Plan off ahead of an older queued Plan on', async () => {
    const f = fixture();
    f.handle.configOptions = [
      {
        id: 'collaboration_mode',
        name: 'Planning',
        type: 'select',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default' }],
      },
    ];
    await f.queued.capture('session', 'collaboration_mode', async () => undefined)();
    const plan = vi.fn(async () => undefined);
    const settings = await f.queued.configure(
      'session',
      { ...f.message, settings: { ...f.message.settings, planModeEnabled: true } },
      false,
      {
        plan,
        model: async () => undefined,
        reasoning: async () => undefined,
        thinking: async () => undefined,
      }
    );
    expect(settings.planModeEnabled).toBe(false);
    expect(plan).not.toHaveBeenCalled();
    expect(f.handle.configOptions[0]?.currentValue).toBe('default');
  });
});
