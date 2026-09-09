import { describe, expect, it } from 'vitest';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';

const groupedModel = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'custom',
  _meta: { custom: { enabled: true } },
  options: [
    {
      group: 'custom',
      name: 'Custom',
      options: [
        { value: 'custom', name: 'Custom model', description: null, _meta: { source: 'provider' } },
      ],
    },
  ],
};

describe('parseAcpConfigSnapshot', () => {
  it.each(['CLAUDE', 'CODEX'])(
    'preserves %s grouped options and protocol extension metadata',
    (provider) => {
      expect(
        parseAcpConfigSnapshot({
          acpConfigSnapshot: {
            provider,
            providerSessionId: 'provider-1',
            capturedAt: '2026-09-08T12:00:00.000Z',
            observedModelId: 'custom',
            configOptions: [groupedModel],
          },
        })
      ).toEqual({
        provider,
        providerSessionId: 'provider-1',
        capturedAt: '2026-09-08T12:00:00.000Z',
        observedModelId: 'custom',
        configOptions: [groupedModel],
      });
    }
  );

  it('retains compatibility with snapshots missing optional metadata', () => {
    expect(
      parseAcpConfigSnapshot({
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'provider-1',
          configOptions: [],
          observedModelId: 42,
        },
      })
    ).toEqual({
      provider: 'CODEX',
      providerSessionId: 'provider-1',
      capturedAt: '1970-01-01T00:00:00.000Z',
      configOptions: [],
    });
  });

  it.each([
    null,
    [],
    {},
    { acpConfigSnapshot: null },
    {
      acpConfigSnapshot: {
        provider: 'UNKNOWN',
        providerSessionId: 'provider-1',
        configOptions: [],
      },
    },
    {
      acpConfigSnapshot: {
        provider: 'CLAUDE',
        providerSessionId: '',
        configOptions: [],
      },
    },
  ])('rejects invalid snapshot envelopes: %j', (metadata) => {
    expect(parseAcpConfigSnapshot(metadata)).toBeNull();
  });
});
