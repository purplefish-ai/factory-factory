// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useSessionLaunchSelection,
  useSessionLaunchSelectionState,
  type SessionLaunchDefaults,
} from './use-session-launch-selection';

const mocks = vi.hoisted(() => ({
  settings: undefined as SessionLaunchDefaults | undefined,
  catalog: undefined as
    | {
        CLAUDE: { models: { value: string; label: string }[] };
        CODEX: { models: { value: string; label: string }[] };
      }
    | undefined,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    userSettings: {
      get: { useQuery: () => ({ data: mocks.settings }) },
      getProviderOptions: { useQuery: () => ({ data: mocks.catalog, isLoading: !mocks.catalog }) },
    },
  },
}));
const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
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
  it('keeps each provider model independent while toggling providers', () => {
    const mounted = mount(defaults);
    expect(mounted.current.model).toBe('saved-sol');
    flushSync(() => mounted.current.onModelChange('chosen-luna'));
    flushSync(() => mounted.current.onProviderChange('CLAUDE'));
    expect(mounted.current.model).toBe('saved-sonnet');
    flushSync(() => mounted.current.onModelChange('chosen-opus'));
    flushSync(() => mounted.current.onProviderChange('CODEX'));
    expect(mounted.current.model).toBe('chosen-luna');
    flushSync(() => mounted.current.onProviderChange('CLAUDE'));
    expect(mounted.current.model).toBe('chosen-opus');
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
    expect(result?.creationDefaults).toEqual({ provider: 'CODEX', model: 'default' });
    expect(result?.pickerProps.models).toEqual([{ value: 'default', label: 'Provider default' }]);
    expect(result?.pickerProps.modelsLoading).toBe(true);
    expect(result?.loading).toBe(false);
  });
});
