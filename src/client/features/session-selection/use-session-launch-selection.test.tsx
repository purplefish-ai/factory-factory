// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import {
  useSessionLaunchSelection,
  useSessionLaunchSelectionState,
  type SessionLaunchDefaults,
} from './use-session-launch-selection';

const mocks = vi.hoisted(() => ({
  settings: undefined as SessionLaunchDefaults | undefined,
  launches: new Map<string, SessionLaunchOptions | undefined>(),
  launchErrors: new Map<string, Error>(),
  refetchLaunch: vi.fn().mockResolvedValue({}),
  settingsError: null as Error | null,
  refetchSettings: vi.fn().mockResolvedValue({}),
  catalog: undefined as
    | {
        CLAUDE: { models: { value: string; label: string }[] };
        CODEX: { models: { value: string; label: string }[] };
      }
    | undefined,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      getLaunchOptions: {
        useQuery: (input: { provider: 'CLAUDE' | 'CODEX'; model?: string }) => {
          const key = `${input.provider}:${input.model}`;
          return {
            data: mocks.launches.has(key)
              ? mocks.launches.get(key)
              : {
                  provider: input.provider,
                  model: input.model ?? 'native',
                  reasoning: { options: [] },
                  planMode: { supported: false, selected: false },
                },
            error: mocks.launchErrors.get(key),
            refetch: mocks.refetchLaunch,
          };
        },
      },
    },
    userSettings: {
      get: {
        useQuery: () => ({
          data: mocks.settings,
          error: mocks.settingsError,
          refetch: mocks.refetchSettings,
        }),
      },
      getProviderOptions: { useQuery: () => ({ data: mocks.catalog, isLoading: !mocks.catalog }) },
    },
  },
}));
const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  mocks.launches.clear();
  mocks.launchErrors.clear();
});
const defaults: SessionLaunchDefaults = {
  defaultSessionProvider: 'CODEX',
  defaultCodexModel: 'saved-sol',
  defaultClaudeModel: 'saved-sonnet',
};
type LaunchState = ReturnType<typeof useSessionLaunchSelectionState>;
function LaunchStateHarness({
  scopeKey,
  settings,
  onResult,
}: {
  scopeKey: string;
  settings?: SessionLaunchDefaults;
  onResult: (result: LaunchState) => void;
}) {
  onResult(useSessionLaunchSelectionState(scopeKey, settings));
  return null;
}
function ConnectedLaunchHarness({
  onResult,
}: {
  onResult: (result: ReturnType<typeof useSessionLaunchSelection>) => void;
}) {
  onResult(useSessionLaunchSelection('workspace'));
  return null;
}

function mount(seed: SessionLaunchDefaults | undefined) {
  let result: ReturnType<typeof useSessionLaunchSelectionState> | undefined;
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = (scopeKey: string, settings = seed) =>
    flushSync(() =>
      root.render(
        createElement(LaunchStateHarness, {
          scopeKey,
          settings,
          onResult: (next) => {
            result = next;
          },
        })
      )
    );
  render('workspace-a');
  return {
    render,
    get current() {
      if (!result) {
        throw new Error('Hook not mounted');
      }
      return result;
    },
  };
}

describe('launch selection ownership', () => {
  it('keeps explicit provider and model choices through settings refetches', () => {
    const mounted = mount(defaults);
    flushSync(() => mounted.current.onProviderChange('CLAUDE'));
    flushSync(() => mounted.current.onModelChange('chosen-opus'));
    mounted.render('workspace-a', {
      ...defaults,
      defaultSessionProvider: 'CODEX',
      defaultClaudeModel: 'new-default',
    });
    expect(mounted.current.provider).toBe('CLAUDE');
    expect(mounted.current.model).toBe('chosen-opus');
  });
  it('selects the saved model default when clicking a provider, including the current provider', () => {
    const mounted = mount(defaults);
    expect(mounted.current.model).toBe('saved-sol');
    flushSync(() => mounted.current.onModelChange('chosen-luna'));
    flushSync(() => mounted.current.onProviderChange('CLAUDE'));
    expect(mounted.current.model).toBe('saved-sonnet');
    flushSync(() => mounted.current.onModelChange('chosen-opus'));
    flushSync(() => mounted.current.onProviderChange('CODEX'));
    expect(mounted.current.model).toBe('saved-sol');
    flushSync(() => mounted.current.onProviderChange('CLAUDE'));
    expect(mounted.current.model).toBe('saved-sonnet');
    flushSync(() => mounted.current.onModelChange('chosen-opus'));
    flushSync(() => mounted.current.onProviderChange('CLAUDE'));
    expect(mounted.current.model).toBe('saved-sonnet');
  });
  it('applies a different provider and model atomically without overwriting the previous provider draft', () => {
    const mounted = mount(defaults);
    flushSync(() => mounted.current.onProviderChange('CLAUDE', 'chosen-opus'));
    expect(mounted.current.provider).toBe('CLAUDE');
    expect(mounted.current.model).toBe('chosen-opus');
    flushSync(() => mounted.current.onProviderChange('CODEX'));
    expect(mounted.current.model).toBe('saved-sol');
  });
  it('waits for saved defaults and seeds them only once per draft', () => {
    const mounted = mount(undefined);
    // Explicit undefined avoids the helper default argument.
    mounted.render('unseeded', undefined);
    expect(mounted.current.loading).toBe(true);
    mounted.render('unseeded', defaults);
    expect(mounted.current.model).toBe('saved-sol');
    mounted.render('unseeded', { ...defaults, defaultCodexModel: 'later-sol' });
    expect(mounted.current.model).toBe('saved-sol');
  });
  it('resets an in-flight draft with the latest committed saved defaults', () => {
    const mounted = mount(defaults);
    const resetAfterCreate = mounted.current.reset;
    flushSync(() => mounted.current.onModelChange('chosen-luna'));
    mounted.render('workspace-a', { ...defaults, defaultCodexModel: 'latest-sol' });
    flushSync(() => resetAfterCreate());
    expect(mounted.current.model).toBe('latest-sol');
  });

  it('seeds a new workspace or reset draft from current saved defaults', () => {
    const mounted = mount(defaults);
    flushSync(() => mounted.current.onModelChange('chosen-luna'));
    const latest = {
      ...defaults,
      defaultSessionProvider: 'CLAUDE' as const,
      defaultClaudeModel: 'new-sonnet',
    };
    mounted.render('workspace-b', latest);
    expect(mounted.current.provider).toBe('CLAUDE');
    expect(mounted.current.model).toBe('new-sonnet');
    flushSync(() => mounted.current.onModelChange('opus'));
    flushSync(() => mounted.current.reset());
    expect(mounted.current.model).toBe('new-sonnet');
  });
});

describe('connected launch options', () => {
  it('keeps the saved provider default alias visible while its catalog loads', () => {
    mocks.settings = { ...defaults, defaultCodexModel: 'default' };
    mocks.catalog = undefined;
    let result: ReturnType<typeof useSessionLaunchSelection> | undefined;
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    flushSync(() =>
      root.render(
        createElement(ConnectedLaunchHarness, {
          onResult: (next) => {
            result = next;
          },
        })
      )
    );
    expect(result?.creationDefaults).toEqual({
      provider: 'CODEX',
      model: 'default',
      reasoningEffort: null,
      planModeEnabled: false,
    });
    expect(result?.pickerProps.models).toEqual([{ value: 'default', label: 'Provider default' }]);
    expect(result?.pickerProps.modelsLoading).toBe(true);
    expect(result?.loading).toBe(false);
  });
});

it('offers a retry after saved defaults fail instead of leaving selection loading forever', () => {
  mocks.settings = undefined;
  mocks.settingsError = new Error('Connection failed');
  let result: ReturnType<typeof useSessionLaunchSelection> | undefined;
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = () =>
    flushSync(() =>
      root.render(
        createElement(ConnectedLaunchHarness, {
          onResult: (next) => {
            result = next;
          },
        })
      )
    );
  render();
  expect(result?.loading).toBe(false);
  expect(result?.ready).toBe(false);
  expect(result?.pickerProps.error).toBe('Could not load chat defaults');
  result?.pickerProps.onRetry?.();
  expect(mocks.refetchSettings).toHaveBeenCalledOnce();
  mocks.settingsError = null;
  mocks.settings = defaults;
  render();
  expect(result?.ready).toBe(true);
  expect(result?.pickerProps.error).toBeUndefined();
});

it('keeps explicit thinking and Plan drafts per provider through refetch and resets after creation', () => {
  const mounted = mount(defaults);
  flushSync(() => mounted.current.onReasoningChange('xhigh'));
  flushSync(() => mounted.current.onPlanModeChange(true));
  flushSync(() => mounted.current.onProviderChange('CLAUDE'));
  expect(mounted.current.reasoningEffort).toBeUndefined();
  expect(mounted.current.planModeEnabled).toBeUndefined();
  flushSync(() => mounted.current.onReasoningChange(null));
  flushSync(() => mounted.current.onPlanModeChange(false));
  flushSync(() => mounted.current.onProviderChange('CODEX'));
  expect(mounted.current.reasoningEffort).toBe('xhigh');
  expect(mounted.current.planModeEnabled).toBe(true);
  mounted.render('workspace-a', { ...defaults, defaultCodexReasoningEffort: 'low' });
  expect(mounted.current.reasoningEffort).toBe('xhigh');
  flushSync(() => mounted.current.reset());
  expect(mounted.current.reasoningEffort).toBeUndefined();
  expect(mounted.current.planModeEnabled).toBeUndefined();
});

function mountConnected() {
  let result: ReturnType<typeof useSessionLaunchSelection> | undefined;
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = () =>
    flushSync(() =>
      root.render(
        createElement(ConnectedLaunchHarness, {
          onResult: (value) => {
            result = value;
          },
        })
      )
    );
  render();
  return {
    render,
    get current() {
      if (!result) {
        throw new Error('Missing launch selection');
      }
      return result;
    },
  };
}
const solNative: SessionLaunchOptions = {
  provider: 'CODEX',
  model: 'native-sol',
  reasoning: {
    options: [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra' },
    ],
    selected: 'high',
    defaultValue: 'medium',
  },
  planMode: { supported: true, selected: false },
};

it('freezes the effective saved level and preserves an unsupported explicit draft until Default and Plan off', () => {
  mocks.settings = { ...defaults, defaultCodexReasoningEffort: 'high' };
  mocks.launches.set('CODEX:saved-sol', solNative);
  mocks.launches.set('CODEX:luna', {
    ...solNative,
    model: 'native-luna',
    reasoning: {
      options: [{ value: 'medium', label: 'Medium' }],
      defaultValue: 'medium',
      selected: 'medium',
    },
    planMode: { supported: false, selected: false },
  });
  const mounted = mountConnected();
  expect(mounted.current.controlsProps.reasoning?.value).toBe('high');
  expect(mounted.current.creationDefaults.reasoningEffort).toBe('high');
  mocks.settings = { ...defaults, defaultCodexReasoningEffort: 'medium' };
  mounted.render();
  expect(mounted.current.controlsProps.reasoning?.value).toBe('high');
  expect(mounted.current.creationDefaults.reasoningEffort).toBe('high');
  flushSync(() => mounted.current.controlsProps.reasoning?.onChange('ultra'));
  flushSync(() => mounted.current.controlsProps.planMode?.onChange(true));
  mocks.settings = { ...defaults, defaultCodexReasoningEffort: 'medium' };
  mounted.render();
  expect(mounted.current.creationDefaults).toEqual({
    provider: 'CODEX',
    model: 'saved-sol',
    reasoningEffort: 'ultra',
    planModeEnabled: true,
  });
  flushSync(() => mounted.current.pickerProps.onModelChange?.('luna'));
  expect(mounted.current.ready).toBe(false);
  expect(mounted.current.controlsProps.reasoning?.value).toBe('ultra');
  expect(mounted.current.controlsProps.reasoning?.invalid).toBe(true);
  flushSync(() => mounted.current.pickerProps.onProviderChange?.('CLAUDE'));
  flushSync(() => mounted.current.pickerProps.onProviderChange?.('CODEX', 'luna'));
  expect(mounted.current.controlsProps.reasoning?.value).toBe('ultra');
  flushSync(() => mounted.current.controlsProps.reasoning?.onChange(null));
  expect(mounted.current.ready).toBe(false);
  flushSync(() => mounted.current.controlsProps.planMode?.onChange(false));
  expect(mounted.current.ready).toBe(true);
  expect(mounted.current.creationDefaults.reasoningEffort).toBeNull();
});

it('distinguishes pending discovery and failure from known unsupported capabilities, with retry', () => {
  mocks.settings = defaults;
  mocks.launches.set('CODEX:saved-sol', undefined);
  const mounted = mountConnected();
  expect(mounted.current.ready).toBe(false);
  expect(mounted.current.controlsProps.reasoning?.loading).toBe(true);
  mocks.launchErrors.set('CODEX:saved-sol', new Error('Probe failed'));
  mounted.render();
  expect(mounted.current.controlsProps.reasoning?.loading).toBe(false);
  expect(mounted.current.controlsProps.reasoning?.error).toContain('Could not load');
  mounted.current.controlsProps.reasoning?.onRetry();
  expect(mocks.refetchLaunch).toHaveBeenCalled();
  mocks.launchErrors.delete('CODEX:saved-sol');
  mocks.launches.set('CODEX:saved-sol', {
    ...solNative,
    reasoning: { options: [] },
    planMode: { supported: false, selected: false },
  });
  mounted.render();
  expect(mounted.current.ready).toBe(true);
  expect(mounted.current.controlsProps.reasoning?.loading).toBe(false);
  expect(mounted.current.controlsProps.reasoning?.error).toBeUndefined();
});

// Saved Default is intent, even when the native default is a concrete advertised level.
it('keeps saved native Default visible and in the outbound payload across native refetch', () => {
  mocks.settings = { ...defaults, defaultCodexReasoningEffort: null };
  mocks.launches.set('CODEX:saved-sol', solNative);
  const mounted = mountConnected();
  expect(mounted.current.ready).toBe(true);
  expect(mounted.current.controlsProps.reasoning?.value).toBeNull();
  expect(mounted.current.creationDefaults.reasoningEffort).toBeNull();
  mocks.launches.set('CODEX:saved-sol', {
    ...solNative,
    reasoning: { ...solNative.reasoning, defaultValue: 'high', selected: 'high' },
  });
  mounted.render();
  expect(mounted.current.controlsProps.reasoning?.value).toBeNull();
  expect(mounted.current.creationDefaults.reasoningEffort).toBeNull();
});

it('submits the displayed permission default and preserves explicit access per provider until reset', () => {
  mocks.settings = { ...defaults, defaultWorkspacePermissions: 'RELAXED' };
  mocks.launches.set('CODEX:saved-sol', {
    ...solNative,
    accessMode: {
      options: [
        { value: 'workspace-write', label: 'Workspace' },
        { value: 'agent', label: 'Auto' },
        { value: 'agent-full-access', label: 'Full access' },
      ],
      selected: 'workspace-write',
    },
  });
  const mounted = mountConnected();
  expect(mounted.current.creationDefaults.accessMode).toBe('agent');
  expect(mounted.current.controlsProps.accessMode?.value).toBe('agent');
  flushSync(() => mounted.current.controlsProps.accessMode?.onChange('agent-full-access'));
  flushSync(() => mounted.current.pickerProps.onProviderChange?.('CLAUDE'));
  flushSync(() => mounted.current.pickerProps.onProviderChange?.('CODEX'));
  mocks.settings = { ...defaults, defaultWorkspacePermissions: 'STRICT' };
  mounted.render();
  expect(mounted.current.creationDefaults.accessMode).toBe('agent-full-access');
  flushSync(() => mounted.current.reset());
  expect(mounted.current.creationDefaults.accessMode).toBe('workspace-write');
});

it('blocks launch when explicit access becomes unavailable after a model switch', () => {
  mocks.settings = defaults;
  mocks.launches.set('CODEX:saved-sol', {
    ...solNative,
    accessMode: { options: [{ value: 'agent', label: 'Auto' }] },
  });
  const mounted = mountConnected();
  flushSync(() => mounted.current.controlsProps.accessMode?.onChange('agent'));
  flushSync(() => mounted.current.pickerProps.onModelChange?.('luna'));
  expect(mounted.current.ready).toBe(false);
  expect(mounted.current.unavailableReason).toContain('access mode');
});

it('requires an explicit permission choice when a saved strict preset is unavailable, even if native defaults grant full access', () => {
  mocks.settings = { ...defaults, defaultWorkspacePermissions: 'STRICT' };
  mocks.launches.set('CODEX:saved-sol', {
    ...solNative,
    accessMode: {
      options: [{ value: 'agent-full-access', label: 'Full access' }],
      selected: 'agent-full-access',
    },
  });
  const mounted = mountConnected();
  expect(mounted.current.ready).toBe(false);
  expect(mounted.current.controlsProps.accessMode?.invalid).toBe(true);
  expect(mounted.current.creationDefaults.accessMode).toBeUndefined();
  flushSync(() => mounted.current.controlsProps.accessMode?.onChange('agent-full-access'));
  expect(mounted.current.ready).toBe(true);
  expect(mounted.current.creationDefaults.accessMode).toBe('agent-full-access');
});
