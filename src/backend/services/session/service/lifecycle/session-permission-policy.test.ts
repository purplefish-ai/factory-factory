import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  applyReadOnlyReviewPermissions,
  assertReadOnlyReviewConfigOption,
  resolveConfiguredAccessModeTarget,
} from './session-permission-policy';

function mode(currentValue: string, values: string[], id = 'mode'): SessionConfigOption {
  return {
    id,
    category: id,
    name: id,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

describe('provider native access policy', () => {
  it.each([
    ['CODEX', 'STRICT', 'workspace-write'],
    ['CODEX', 'RELAXED', 'agent'],
    ['CODEX', 'YOLO', 'agent-full-access'],
    ['CLAUDE', 'STRICT', 'default'],
    ['CLAUDE', 'RELAXED', 'acceptEdits'],
    ['CLAUDE', 'YOLO', 'bypassPermissions'],
  ] as const)('maps %s %s to native access %s', (provider, preset, target) => {
    const option = mode('plan', [
      'default',
      'acceptEdits',
      'bypassPermissions',
      'workspace-write',
      'agent',
      'agent-full-access',
    ]);
    expect(resolveConfiguredAccessModeTarget(provider, option, preset)).toBe(target);
  });

  it('restricts Codex access independently of collaboration mode', async () => {
    const handle = {
      provider: 'CODEX',
      configOptions: [
        mode('agent-full-access', ['read-only', 'workspace-write', 'agent', 'agent-full-access']),
        mode('plan', ['default', 'plan'], 'collaboration_mode'),
      ],
    };
    const runtime = {
      setSessionMode: vi.fn(async (_id: string, value: string) =>
        handle.configOptions.map((option: SessionConfigOption) =>
          option.id === 'mode' && option.type === 'select'
            ? { ...option, currentValue: value }
            : option
        )
      ),
      setConfigOption: vi.fn(),
    };
    await expect(
      applyReadOnlyReviewPermissions('session', unsafeCoerce<AcpProcessHandle>(handle), runtime)
    ).resolves.toBe(true);
    expect(handle.configOptions[0]?.currentValue).toBe('read-only');
    expect(handle.configOptions[1]?.currentValue).toBe('plan');
    expect(runtime.setConfigOption).not.toHaveBeenCalled();
  });

  it.each(['collaboration_mode', 'provider_planning'])(
    'applies review planning identified by %s without changing read-only access',
    async (configId) => {
      const handle = {
        provider: 'CODEX',
        configOptions: [
          mode('read-only', ['read-only', 'workspace-write']),
          { ...mode('default', ['default', 'plan'], configId), category: 'collaboration_mode' },
        ],
      };
      const runtime = {
        setSessionMode: vi.fn(),
        setConfigOption: vi.fn(async (_id: string, configId: string, value: string) =>
          handle.configOptions.map((option: SessionConfigOption) =>
            option.id === configId && option.type === 'select'
              ? { ...option, currentValue: value }
              : option
          )
        ),
      };
      await expect(
        applyReadOnlyReviewPermissions('session', unsafeCoerce<AcpProcessHandle>(handle), runtime)
      ).resolves.toBe(true);
      expect(
        handle.configOptions.map((option: SessionConfigOption) => option.currentValue)
      ).toEqual(['read-only', 'plan']);
    }
  );

  it.each([
    ['CODEX', 'mode', 'workspace-write'],
    ['CODEX', 'collaboration_mode', 'default'],
    ['CLAUDE', 'mode', 'acceptEdits'],
  ] as const)('blocks review broadening via %s %s', (provider, id, value) => {
    expect(() =>
      assertReadOnlyReviewConfigOption(ADVERSARIAL_REVIEW_WORKFLOW, id, value, undefined, provider)
    ).toThrow('read-only');
  });

  it.each([
    ['CODEX', 'mode', 'read-only'],
    ['CODEX', 'collaboration_mode', 'plan'],
    ['CLAUDE', 'mode', 'plan'],
  ] as const)('allows safe review setting %s %s', (provider, id, value) => {
    expect(() =>
      assertReadOnlyReviewConfigOption(ADVERSARIAL_REVIEW_WORKFLOW, id, value, undefined, provider)
    ).not.toThrow();
  });
});
