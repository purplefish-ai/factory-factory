import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { requireSessionConfigOptions } from './acp-session-config-options';

function modelOption(value = 'gpt-4o'): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: value,
    options: [{ value, name: value }],
  };
}

function modeOption(value = 'default'): SessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue: value,
    options: [{ value, name: value }],
  };
}

describe('requireSessionConfigOptions', () => {
  describe('OPENHANDS (router-backed provider)', () => {
    it('accepts a response with only `mode` (no model selector)', () => {
      const result = requireSessionConfigOptions('OPENHANDS', 'newSession', {
        configOptions: [modeOption()],
      });
      expect(result.map((o) => o.category)).toEqual(['mode']);
    });

    it('derives `mode` from the fallback when configOptions is omitted', () => {
      const result = requireSessionConfigOptions('OPENHANDS', 'newSession', {
        configOptions: null,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      });
      expect(result.map((o) => o.category)).toEqual(['mode']);
    });

    it('still requires `mode`', () => {
      expect(() =>
        requireSessionConfigOptions('OPENHANDS', 'newSession', {
          configOptions: [modelOption()],
        })
      ).toThrow(/missing required config option categories: mode/);
    });

    it('throws when no options can be derived at all', () => {
      expect(() =>
        requireSessionConfigOptions('OPENHANDS', 'newSession', { configOptions: null })
      ).toThrow(/did not include required configOptions/);
    });
  });

  describe('CLAUDE / CODEX (regression guard: model + mode both required)', () => {
    it.each(['CLAUDE', 'CODEX'])('%s requires `model`', (provider) => {
      expect(() =>
        requireSessionConfigOptions(provider, 'newSession', {
          configOptions: [modeOption()],
        })
      ).toThrow(/missing required config option categories: model/);
    });

    it.each(['CLAUDE', 'CODEX'])('%s requires `mode`', (provider) => {
      expect(() =>
        requireSessionConfigOptions(provider, 'newSession', {
          configOptions: [modelOption()],
        })
      ).toThrow(/missing required config option categories: mode/);
    });

    it.each(['CLAUDE', 'CODEX'])('%s accepts model + mode', (provider) => {
      const result = requireSessionConfigOptions(provider, 'newSession', {
        configOptions: [modelOption(), modeOption()],
      });
      expect(result.map((o) => o.category).sort()).toEqual(['mode', 'model']);
    });
  });
});
