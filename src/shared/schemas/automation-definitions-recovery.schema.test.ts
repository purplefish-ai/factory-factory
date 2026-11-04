import { describe, expect, it } from 'vitest';
import fixed from '@/shared/testing/recovery-automation-definitions-v8.fixture.json';
import { automationDefinitionsRecoverySchema } from './automation-definitions-recovery.schema';
import { exportDataSchema } from './export-data.schema';

describe('independent automation definition body recovery contract', () => {
  it('preserves the independently authored current wire including all ten scalars', () => {
    const parsed = exportDataSchema.parse(fixed);
    expect(parsed).toEqual(fixed);
    expect(exportDataSchema.parse(parsed)).toEqual(fixed);
  });
});

const section = () => structuredClone(fixed.data.recovery.automationDefinitions);

describe('strict definition body boundary', () => {
  it.each([
    [{ version: 1 }, { version: 1 }],
    [
      { version: 1, provider: 'CLAUDE' },
      { version: 1, provider: 'CLAUDE' },
    ],
    [
      { reasoningEffort: 'high', model: 'custom-model', provider: 'CODEX', version: 1 },
      { version: 1, provider: 'CODEX', model: 'custom-model', reasoningEffort: 'high' },
    ],
  ])('preserves supported preferences without defaults: %j', (input, expected) => {
    const value = section();
    Object.assign(value.definitions[0]!, { executionConfig: input });
    expect(
      automationDefinitionsRecoverySchema.parse(value).definitions[0]?.executionConfig
    ).toEqual(expected);
  });

  it.each([
    ['provider', undefined],
    ['model', undefined],
    ['reasoningEffort', undefined],
    ['model', ' custom-model'],
    ['reasoningEffort', 'high '],
  ])('rejects own undefined or noncanonical %s=%j', (key, value) => {
    const input = section();
    if (key === 'provider') {
      Object.assign(input.definitions[0]!, { executionConfig: { version: 1 } });
    }
    Object.assign(input.definitions[0]!.executionConfig, { [key]: value });
    const result = automationDefinitionsRecoverySchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual({
        code: 'custom',
        path: ['definitions', 0, 'executionConfig', key],
        message: 'Noncanonical execution preference',
      });
    }
  });

  it.each([
    null,
    [],
    'opaque',
    { version: 2 },
    { version: 1, model: 'custom' },
    { version: 1, provider: 'CLAUDE', model: 'gpt-5' },
    { version: 1, provider: 'CODEX', model: '   ' },
    { version: 1, env: {} },
    { version: 1, accountId: 'local' },
    { version: 1, token: 'secret' },
    { version: 1, path: '/home/source' },
    { version: 1, future: undefined },
  ])('rejects unsupported structured preferences %j', (executionConfig) => {
    const input = section();
    Object.assign(input.definitions[0]!, { executionConfig });
    expect(automationDefinitionsRecoverySchema.safeParse(input).success).toBe(false);
  });

  it.each(Object.keys(fixed.data.recovery.automationDefinitions.definitions[0]!))(
    'requires scalar %s',
    (key) => {
      const input = section();
      Reflect.deleteProperty(input.definitions[0]!, key);
      expect(automationDefinitionsRecoverySchema.safeParse(input).success).toBe(false);
    }
  );

  it.each([
    ['definitionRevision', 0],
    ['definitionRevision', 2_147_483_648],
    ['managementRevision', 1.5],
    ['createdAt', '2026-02-30'],
    ['updatedAt', '2026-01-01T00:00:00+02:00'],
    ['future', undefined],
  ])('rejects invalid row %s=%j', (key, value) => {
    const input = section();
    Object.assign(input.definitions[0]!, { [key]: value });
    expect(automationDefinitionsRecoverySchema.safeParse(input).success).toBe(false);
  });

  it('accepts exhausted positive Int32 highwaters and raw authored text', () => {
    const input = section();
    input.definitions[0]!.definitionRevision = 2_147_483_647;
    input.definitions[0]!.managementRevision = 2_147_483_647;
    expect(automationDefinitionsRecoverySchema.parse(input)).toEqual(input);
  });

  it('rejects duplicate global IDs with an indexed diagnostic, allowing equal names', () => {
    const input = section();
    input.definitions.push({ ...input.definitions[0]! });
    expect(automationDefinitionsRecoverySchema.safeParse(input).error?.issues).toEqual([
      {
        code: 'custom',
        path: ['definitions', 1, 'id'],
        message: 'Duplicate automation definition identity',
      },
    ]);
    input.definitions[1]!.id = 'same-name-new-id';
    expect(automationDefinitionsRecoverySchema.parse(input)).toEqual(input);
  });

  it('requires in-file parents even when a destination could contain that ID', () => {
    const input = structuredClone(fixed);
    input.data.projects = [];
    expect(exportDataSchema.safeParse(input).success).toBe(false);
  });

  it.each(['automationDefinitions', 'periodicHistory', 'periodicConfig', 'baseJson'])(
    'requires capability and section %s even when empty',
    (key) => {
      const noSection = structuredClone(fixed);
      Reflect.deleteProperty(noSection.data.recovery, key);
      expect(exportDataSchema.safeParse(noSection).success).toBe(false);
      const noCapability = structuredClone(fixed);
      Reflect.deleteProperty(noCapability.meta.recovery.capabilities, key);
      expect(exportDataSchema.safeParse(noCapability).success).toBe(false);
    }
  );

  it('rejects own undefined and unknown section/declaration keys', () => {
    for (const path of ['metadata', 'capabilities', 'sections', 'section'] as const) {
      const input = structuredClone(fixed);
      const target = {
        metadata: input.meta.recovery,
        capabilities: input.meta.recovery.capabilities,
        sections: input.data.recovery,
        section: input.data.recovery.automationDefinitions,
      }[path];
      Object.assign(target, { future: undefined });
      expect(exportDataSchema.safeParse(input).success).toBe(false);
    }
  });
});

it.each(['name', 'instructions'] as const)(
  'rejects blank %s without rewriting meaningful raw text',
  (field) => {
    for (const value of ['', ' ', '\n\t']) {
      const input = section();
      input.definitions[0]![field] = value;
      expect(automationDefinitionsRecoverySchema.safeParse(input).error?.issues).toEqual([
        {
          code: 'custom',
          path: ['definitions', 0, field],
          message: 'Definition text must not be blank',
        },
      ]);
    }
    const input = section();
    input.definitions[0]![field] = '  Meaningful raw text.\n';
    expect(automationDefinitionsRecoverySchema.parse(input)).toEqual(input);
  }
);
