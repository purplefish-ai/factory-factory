import { expect, it } from 'vitest';
import { EventSessionAuthority } from './event-session-authority';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
const execution = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  reasoningEffort: null,
  codexAccountId: null,
  startupModePreset: 'non_interactive' as const,
  accessMode: 'bypassPermissions',
  planModeEnabled: false as const,
};
it.each(['start', 'get', 'browse', 'restart'] as const)(
  'blocks ordinary %s before a provider can start without durable event authority',
  async (mode) => {
    const eventAuthority = new EventSessionAuthority(async () => ({
      runId: 'event-run',
      execution,
    }));
    const h = createLifecycleHarness({ eventAuthority });
    const call =
      mode === 'start'
        ? h.service.startSession(h.session.id)
        : mode === 'get'
          ? h.service.getOrCreateSessionClient(h.session.id)
          : mode === 'browse'
            ? h.service.ensureSubagentBrowseSession(h.session.id)
            : h.service.restartSession(h.session.id);
    await expect(call).rejects.toThrow('Event initial delivery is fenced');
    expect(h.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  }
);
