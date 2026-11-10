import { describe, expect, it } from 'vitest';
import { buildStoredConfigProjection } from './session-config-projection';

describe('pre-start effort projection', () => {
  it.each([null, 'high'])(
    'waits for native configuration instead of displaying catalog effort (launch=%s)',
    (reasoningEffort) => {
      const session = {
        provider: 'CODEX' as const,
        model: 'codex',
        providerMetadata: {
          launchSettings: { reasoningEffort, planModeEnabled: false, applied: false },
        },
      };
      const projection = buildStoredConfigProjection(session, [
        {
          id: 'codex',
          displayName: 'Codex',
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
        },
      ]);

      expect(projection.capabilities.model.selected).toBe('codex');
      expect(projection.capabilities.reasoning).toEqual({ enabled: false, options: [] });
      expect(projection.configOptions.map((option) => option.id)).toEqual(['model']);
      expect(session.providerMetadata.launchSettings.applied).toBe(false);
    }
  );
});
