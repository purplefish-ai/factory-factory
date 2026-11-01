import { describe, expect, it, vi } from 'vitest';
import type { AgentContentItem } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { EventSessionAuthority } from './event-session-authority';
import { SessionLifecycleGate } from './session-lifecycle-gate';
import { SessionService, type SessionServiceDependencies } from './session.service';

function harness(supportsImages = true, eventAuthority?: EventSessionAuthority) {
  const runtime = {
    getClient: () => ({ supportsImages: () => supportsImages }),
    steerSession: vi.fn().mockResolvedValue({ outcome: 'injected' }),
    sendPrompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    isSessionWorking: () => false,
  };
  const processor = {
    getWorkspaceId: () => undefined,
    beginPromptTurn: vi.fn(() => 'original-attempt'),
    finishPromptTurn: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
  };
  const domain = { setRuntimeSnapshot: vi.fn() };
  const completion = { schedule: vi.fn() };
  const lifecycleGate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
  const service = new SessionService(
    unsafeCoerce<SessionServiceDependencies>({
      eventAuthority,
      runtimeManager: runtime,
      sessionDomainService: domain,
      acpEventProcessor: processor,
      promptTurnCompletionService: completion,
      lifecycleEventService: { record: vi.fn() },
      lifecycleGate,
    })
  );
  return { service, runtime, processor, domain, completion, lifecycleGate };
}

const image: AgentContentItem = {
  type: 'image',
  source: { type: 'base64', data: 'aW1hZ2U=', media_type: 'image/png' },
};

describe('SessionService steering conversion', () => {
  it('converts string steering into a text block without starting another prompt', async () => {
    const { service, runtime, processor } = harness();

    await expect(service.steerSessionMessage('session', 'Focus on tests')).resolves.toEqual({
      outcome: 'injected',
    });

    expect(runtime.steerSession).toHaveBeenCalledExactlyOnceWith('session', [
      { type: 'text', text: 'Focus on tests' },
    ]);
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(processor.beginPromptTurn).not.toHaveBeenCalled();
  });

  it('converts image content to the native ACP image block for supported providers', async () => {
    const { service, runtime } = harness(true);

    await service.steerSessionMessage('session', [{ type: 'text', text: 'See this' }, image]);

    expect(runtime.steerSession).toHaveBeenCalledExactlyOnceWith('session', [
      { type: 'text', text: 'See this' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
  });

  it('replaces unsupported image content with the provider placeholder', async () => {
    const { service, runtime } = harness(false);

    await service.steerSessionMessage('session', [image]);

    expect(runtime.steerSession).toHaveBeenCalledExactlyOnceWith('session', [
      { type: 'text', text: '[Image: not supported by this provider]' },
    ]);
  });

  it('steers before the original prompt settles without resetting its turn tracking', async () => {
    const { service, runtime, processor, domain, completion } = harness();
    let resolveOriginal!: (result: { stopReason: string }) => void;
    const originalResponse = new Promise<{ stopReason: string }>((resolve) => {
      resolveOriginal = resolve;
    });
    runtime.sendPrompt.mockReturnValueOnce(originalResponse);
    let originalSettled = false;
    const original = service.sendSessionMessage('session', 'Original task').finally(() => {
      originalSettled = true;
    });
    try {
      await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce());
      await service.steerSessionMessage('session', 'Updated task');

      expect(originalSettled).toBe(false);
      expect(runtime.steerSession).toHaveBeenCalledExactlyOnceWith('session', [
        { type: 'text', text: 'Updated task' },
      ]);
      expect(processor.beginPromptTurn).toHaveBeenCalledExactlyOnceWith('session');
      expect(processor.finishPromptTurn).not.toHaveBeenCalled();
      expect(processor.finalizeOrphanedToolCalls).not.toHaveBeenCalled();
      expect(domain.setRuntimeSnapshot).toHaveBeenCalledOnce();
      expect(completion.schedule).not.toHaveBeenCalled();
    } finally {
      resolveOriginal({ stopReason: 'end_turn' });
      await original;
    }
    expect(processor.finishPromptTurn).toHaveBeenCalledExactlyOnceWith('session');
    expect(completion.schedule).toHaveBeenCalledExactlyOnceWith('session');
  });
});

it.each(['send', 'steer'] as const)(
  'blocks direct ordinary %s before observer restoration',
  async (mode) => {
    const authority = new EventSessionAuthority(async () => ({
      runId: 'run',
      execution: {
        version: 1,
        provider: 'CLAUDE',
        model: 'sonnet',
        reasoningEffort: null,
        codexAccountId: null,
        startupModePreset: 'non_interactive',
        accessMode: 'bypassPermissions',
        planModeEnabled: false,
      },
    }));
    const h = harness(true, authority);
    await expect(
      mode === 'send'
        ? h.service.sendSessionMessage('session', 'human')
        : h.service.steerSessionMessage('session', 'human')
    ).rejects.toThrow();
    expect(h.runtime.sendPrompt).not.toHaveBeenCalled();
    expect(h.runtime.steerSession).not.toHaveBeenCalled();
  }
);

it.each(['send', 'steer'] as const)(
  'rejects stale ordinary %s when stop races durable ownership lookup',
  async (mode) => {
    let finishLookup!: () => void;
    const authority = new EventSessionAuthority(
      () =>
        new Promise((resolve) => {
          finishLookup = () => resolve(null);
        })
    );
    const h = harness(true, authority);
    const pending =
      mode === 'send'
        ? h.service.sendSessionMessage('session', 'old input')
        : h.service.steerSessionMessage('session', 'old input');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    h.lifecycleGate.reserveStop('session')?.release();
    finishLookup();
    await rejected;
    expect(h.runtime.sendPrompt).not.toHaveBeenCalled();
    expect(h.runtime.steerSession).not.toHaveBeenCalled();
  }
);
