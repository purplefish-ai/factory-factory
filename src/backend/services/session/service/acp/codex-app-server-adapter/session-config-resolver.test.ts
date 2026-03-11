import { describe, expect, it } from 'vitest';
import type { AdapterSession, CodexModelEntry, CollaborationModeEntry } from './adapter-state';
import {
  buildConfigOptions,
  createSandboxPolicyFromMode,
  getCollaborationModeValues,
  getExecutionPresets,
  isKnownModel,
  isReasoningEffortSupportedForModel,
  resolveCollaborationModeLabel,
  resolveCurrentSandboxMode,
  resolveDefaultCollaborationMode,
  resolveDefaultModel,
  resolveExecutionPresetId,
  resolveReasoningEffortForModel,
  resolveSandboxPolicy,
  resolveSessionModel,
  resolveTurnCollaborationMode,
} from './session-config-resolver';

const modelCatalog: CodexModelEntry[] = [
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    description: 'Primary model',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
    inputModalities: ['text'],
    isDefault: true,
  },
  {
    id: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    description: 'Fallback model',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [],
    inputModalities: ['text'],
    isDefault: false,
  },
];

const collaborationModes: CollaborationModeEntry[] = [
  {
    mode: 'default',
    name: 'Default',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    developerInstructions: null,
  },
  {
    mode: 'plan',
    name: 'Plan',
    model: 'gpt-5',
    reasoningEffort: 'high',
    developerInstructions: 'think first',
  },
];

function createSession(overrides?: Partial<AdapterSession>): AdapterSession {
  return {
    sessionId: 'session-1',
    threadId: 'thread-1',
    cwd: '/tmp/workspace',
    defaults: {
      model: 'gpt-5',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite' },
      reasoningEffort: 'medium',
      collaborationMode: 'default',
    },
    activeTurn: null,
    toolCallsByItemId: new Map(),
    syntheticallyCompletedToolItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
    planTextByItemId: new Map(),
    planApprovalRequestedByTurnId: new Set(),
    pendingPlanApprovalsByTurnId: new Map(),
    pendingTurnCompletionsByTurnId: new Map(),
    commandApprovalScopes: new Set(),
    replayedTurnItemKeys: new Set(),
    ...overrides,
  };
}

describe('session-config-resolver helpers', () => {
  it('resolves default model from preferred default, then fallback, else throws', () => {
    const fallbackOnlyModel: CodexModelEntry = { ...modelCatalog[1]!, isDefault: false };
    expect(resolveDefaultModel(modelCatalog)).toBe('gpt-5');
    expect(resolveDefaultModel([fallbackOnlyModel])).toBe('gpt-5-mini');
    expect(() => resolveDefaultModel([])).toThrow('model/list returned no models');
  });

  it('resolves session model and sandbox policy with fallbacks', () => {
    expect(resolveSessionModel('gpt-5-mini', 'gpt-5')).toBe('gpt-5-mini');
    expect(resolveSessionModel('', 'gpt-5')).toBe('gpt-5');
    expect(resolveSandboxPolicy({ type: 'dangerFullAccess' }, '/tmp/work')).toEqual({
      type: 'dangerFullAccess',
    });
    expect(resolveSandboxPolicy(null, '/tmp/work')).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/tmp/work'],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it('resolves default collaboration mode and validates invalid input', () => {
    expect(resolveDefaultCollaborationMode(collaborationModes)).toBe('default');
    expect(
      resolveDefaultCollaborationMode([
        {
          mode: 'code',
          name: 'Code',
          model: null,
          reasoningEffort: null,
          developerInstructions: null,
        },
      ])
    ).toBe('code');
    expect(() => resolveDefaultCollaborationMode([])).toThrow('returned no modes');
    expect(() =>
      resolveDefaultCollaborationMode([
        {
          mode: '',
          name: 'Broken',
          model: null,
          reasoningEffort: null,
          developerInstructions: null,
        },
      ])
    ).toThrow('invalid mode entry');
  });

  it('resolves reasoning effort from candidates and defaults', () => {
    expect(resolveReasoningEffortForModel(modelCatalog, 'gpt-5', 'high')).toBe('high');
    expect(resolveReasoningEffortForModel(modelCatalog, 'gpt-5', 'unsupported')).toBe('medium');
    expect(resolveReasoningEffortForModel(modelCatalog, 'gpt-5-mini', 'high')).toBeNull();
    expect(resolveReasoningEffortForModel(modelCatalog, 'missing', 'high')).toBeNull();
  });

  it('derives collaboration mode values and labels', () => {
    expect(getCollaborationModeValues(collaborationModes, 'plan')).toEqual(['default', 'plan']);
    expect(getCollaborationModeValues(collaborationModes, 'code')).toEqual([
      'code',
      'default',
      'plan',
    ]);
    expect(resolveCollaborationModeLabel(collaborationModes, 'default')).toBe('Default');
    expect(resolveCollaborationModeLabel(collaborationModes, 'accept_edits')).toBe('Accept Edits');
  });

  it('resolves current sandbox mode from policy or allowed values', () => {
    expect(resolveCurrentSandboxMode(['read-only'], { type: 'readOnly' })).toBe('read-only');
    expect(resolveCurrentSandboxMode(['workspace-write'], { type: 'unknown' })).toBe(
      'workspace-write'
    );
    expect(() => resolveCurrentSandboxMode([], { type: 'unknown' })).toThrow(
      'Unable to resolve current sandbox mode'
    );
  });

  it('builds execution presets and chooses the current preset id when present', () => {
    const session = createSession({
      defaults: {
        ...createSession().defaults,
        approvalPolicy: 'on-request',
        sandboxPolicy: createSandboxPolicyFromMode('workspace-write', '/tmp/workspace'),
      },
    });
    const presets = getExecutionPresets(
      session,
      ['on-request', 'never'],
      ['workspace-write', 'danger-full-access']
    );

    expect(presets[0]?.description).toContain('Current session');
    expect(
      presets.some((preset) => preset.id === JSON.stringify(['never', 'danger-full-access']))
    ).toBe(true);

    const current = resolveExecutionPresetId(session, presets, ['workspace-write']);
    expect(current).toBe(JSON.stringify(['on-request', 'workspace-write']));

    const fallback = resolveExecutionPresetId(
      createSession({
        defaults: {
          ...createSession().defaults,
          approvalPolicy: 'untrusted',
          sandboxPolicy: createSandboxPolicyFromMode('danger-full-access', '/tmp/workspace'),
        },
      }),
      presets,
      ['workspace-write']
    );
    expect(fallback).toBe(presets[0]?.id);
  });

  it('builds config options including reasoning when supported', () => {
    const session = createSession();
    const options = buildConfigOptions(
      session,
      modelCatalog,
      collaborationModes,
      ['on-request', 'never'],
      ['workspace-write', 'danger-full-access']
    );

    expect(options.map((option) => option.id)).toEqual([
      'model',
      'mode',
      'execution_mode',
      'reasoning_effort',
    ]);
  });

  it('checks model and reasoning support helpers', () => {
    expect(isKnownModel(modelCatalog, 'gpt-5')).toBe(true);
    expect(isKnownModel(modelCatalog, 'missing')).toBe(false);
    expect(isReasoningEffortSupportedForModel(modelCatalog, 'gpt-5', 'medium')).toBe(true);
    expect(isReasoningEffortSupportedForModel(modelCatalog, 'gpt-5', 'invalid')).toBe(false);
    expect(isReasoningEffortSupportedForModel(modelCatalog, 'missing', 'medium')).toBe(false);
  });

  it('resolves turn collaboration mode with mode defaults', () => {
    const session = createSession({
      defaults: {
        ...createSession().defaults,
        collaborationMode: 'plan',
        model: 'gpt-5-mini',
        reasoningEffort: 'low',
      },
    });
    const mode = resolveTurnCollaborationMode(collaborationModes, session);
    expect(mode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5',
        reasoning_effort: 'high',
        developer_instructions: 'think first',
      },
    });
  });
});
