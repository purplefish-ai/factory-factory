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
    'preserves %s boolean options without select normalization',
    (provider) => {
      const option = { id: 'model', name: 'Toggle', type: 'boolean', currentValue: false };
      expect(
        parseAcpConfigSnapshot({
          acpConfigSnapshot: { provider, providerSessionId: 'provider-1', configOptions: [option] },
        })?.configOptions
      ).toEqual([option]);
    }
  );

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

function legacyCodexSnapshot(execution: string, collaboration = 'plan') {
  return {
    acpConfigSnapshot: {
      provider: 'CODEX',
      providerSessionId: 'sess_original',
      capturedAt: '2026-09-08T12:00:00.000Z',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: collaboration,
          options: ['plan', 'code'].map((value) => ({ value, name: value })),
        },
        {
          id: 'execution_mode',
          name: 'Execution',
          category: 'permission',
          type: 'select',
          currentValue: execution,
          options: [{ value: execution, name: execution }],
        },
      ],
    },
  };
}

describe('legacy Codex configuration migration', () => {
  it.each([
    ['["on-request","workspace-write"]', 'workspace-write'],
    ['["on-failure","workspace-write"]', 'workspace-write'],
    ['["never","workspace-write"]', 'workspace-write'],
    ['["never","read-only"]', 'read-only'],
    ['[ "on-request", "read-only" ]', 'read-only'],
    ['["never","danger-full-access"]', 'agent-full-access'],
  ])(
    'conservatively migrates %s to %s and preserves planning and identity',
    (execution, access) => {
      const snapshot = parseAcpConfigSnapshot(legacyCodexSnapshot(execution));
      expect(snapshot?.providerSessionId).toBe('sess_original');
      expect(snapshot?.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        access
      );
      expect(
        snapshot?.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
      ).toBe('plan');
      expect(snapshot?.configOptions.some((option) => option.id === 'execution_mode')).toBe(false);
    }
  );

  it('migrates the legacy default collaboration mode without dropping access', () => {
    const snapshot = parseAcpConfigSnapshot(
      legacyCodexSnapshot('["on-failure","workspace-write"]', 'default')
    );
    expect(snapshot?.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      'workspace-write'
    );
    expect(
      snapshot?.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
    ).toBe('default');
  });

  it('converts code collaboration to default independently of access', () => {
    expect(
      parseAcpConfigSnapshot(
        legacyCodexSnapshot('["on-request","workspace-write"]', 'code')
      )?.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
    ).toBe('default');
  });

  it.each(['["on-request","danger-full-access"]', '["bad","workspace-write"]', 'invalid'])(
    'fails closed for unrepresentable legacy permissions %s',
    (execution) => {
      expect(parseAcpConfigSnapshot(legacyCodexSnapshot(execution))).toBeNull();
    }
  );
});
