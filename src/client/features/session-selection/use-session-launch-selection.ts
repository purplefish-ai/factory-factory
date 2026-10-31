import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { resolveEffectiveSessionProvider } from '@/lib/session-provider-selection';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';
import type { CodexAccountSummary } from '@/shared/codex-accounts';
import type { SessionPermissionPreset } from '@/shared/core';
import type { SessionLaunchOptions, SessionLaunchSettings } from '@/shared/session-launch';
import { getEffectiveLaunchOptions } from './launch-options-state';
import type { SessionLaunchSelectionSnapshot } from './launch-selection-snapshot';
import type { ProviderModelPickerProps } from './provider-model-picker';
import type { SessionLaunchControlsProps } from './session-launch-controls';

export interface SessionLaunchDefaults {
  defaultSessionProvider: ChatProvider;
  defaultWorkspacePermissions?: SessionPermissionPreset;
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
}

interface ProviderDraft {
  accessMode?: string;
  model?: string;
  codexAccountId?: string;
  reasoningEffort?: string | null;
  planModeEnabled?: boolean;
}
interface LaunchSelectionState {
  scopeKey: string | null;
  defaults: SessionLaunchDefaults | undefined;
  provider?: ChatProvider;
  drafts: Partial<Record<ChatProvider, ProviderDraft>>;
  restoredSnapshot?: SessionLaunchSelectionSnapshot;
}

/** A draft owns a snapshot of saved defaults and its explicit per-provider choices. */
export function useSessionLaunchSelectionState(
  scopeKey: string | null,
  defaults: SessionLaunchDefaults | undefined,
  restoration: {
    snapshot?: SessionLaunchSelectionSnapshot;
    onChange?: (snapshot: SessionLaunchSelectionSnapshot) => void;
  } = {}
) {
  const [stored, setStored] = useState<LaunchSelectionState>(() => ({
    scopeKey,
    defaults,
    drafts: {},
    ...restoration.snapshot,
    restoredSnapshot: restoration.snapshot,
  }));
  const committedDefaults = useRef({ scopeKey, defaults });
  useLayoutEffect(() => {
    committedDefaults.current = { scopeKey, defaults };
  }, [scopeKey, defaults]);
  const reset = useCallback(() => {
    const current = committedDefaults.current;
    setStored({ scopeKey: current.scopeKey, defaults: current.defaults, drafts: {} });
  }, []);
  let state = stored;
  if (stored.scopeKey !== scopeKey || stored.restoredSnapshot !== restoration.snapshot) {
    state = {
      scopeKey,
      defaults,
      drafts: {},
      ...restoration.snapshot,
      restoredSnapshot: restoration.snapshot,
    };
    setStored(state);
  } else if (!stored.defaults && defaults) {
    state = { ...stored, defaults };
    setStored(state);
  }
  const provider = state.provider ?? state.defaults?.defaultSessionProvider ?? null;
  const draft = provider ? state.drafts[provider] : undefined;
  const model =
    draft?.model ??
    (provider === 'CODEX' ? state.defaults?.defaultCodexModel : state.defaults?.defaultClaudeModel);
  const savedReasoningEffort =
    provider === 'CODEX'
      ? state.defaults?.defaultCodexReasoningEffort
      : state.defaults?.defaultClaudeReasoningEffort;
  const latestState = useRef(state);
  latestState.current = state;
  const commit = (next: LaunchSelectionState) => {
    const snapshot: SessionLaunchSelectionSnapshot = {
      provider: next.provider,
      defaults: next.defaults,
      drafts: next.drafts,
    };
    latestState.current = next;
    setStored(next);
    restoration.onChange?.(snapshot);
  };
  const updateDraft = (patch: Partial<ProviderDraft>) => {
    if (provider) {
      const current = latestState.current;
      commit({
        ...current,
        drafts: { ...current.drafts, [provider]: { ...current.drafts[provider], ...patch } },
      });
    }
  };
  return {
    snapshot: {
      provider: state.provider,
      defaults: state.defaults,
      drafts: state.drafts,
    } satisfies SessionLaunchSelectionSnapshot,
    provider,
    model,
    codexAccountId: provider === 'CODEX' ? draft?.codexAccountId : undefined,
    onCodexAccountChange: (codexAccountId: string | undefined) => updateDraft({ codexAccountId }),
    savedReasoningEffort,
    savedAccessPreset: state.defaults?.defaultWorkspacePermissions,
    reasoningEffort: draft?.reasoningEffort,
    planModeEnabled: draft?.planModeEnabled,
    accessMode: draft?.accessMode,
    loading: !state.defaults,
    defaults: state.defaults,
    onProviderChange: (next: ChatProvider, model?: string) => {
      const current = latestState.current;
      commit({
        ...current,
        provider: next,
        drafts: { ...current.drafts, [next]: { ...current.drafts[next], model } },
      });
    },
    onModelChange: (model: string) => updateDraft({ model }),
    onReasoningChange: (reasoningEffort: string | null) => updateDraft({ reasoningEffort }),
    onAccessModeChange: (accessMode: string) => updateDraft({ accessMode }),
    onPlanModeChange: (planModeEnabled: boolean) => updateDraft({ planModeEnabled }),
    reset,
  };
}

export interface SessionLaunchSelection {
  provider: ChatProvider | null;
  model?: string;
  loading: boolean;
  ready: boolean;
  error?: string;
  pickerProps: ProviderModelPickerProps;
  controlsProps: SessionLaunchControlsProps;
  unavailableReason?: string;
  creationDefaults: SessionLaunchSettings & {
    provider?: ChatProvider;
    model?: string;
    codexAccountId?: string;
  };
  snapshot: SessionLaunchSelectionSnapshot;
  reset: () => void;
}

function getModels(
  provider: ChatProvider | null,
  model: string | undefined,
  catalog: Partial<Record<ChatProvider, { models: readonly ChatModelOption[] }>> | undefined
) {
  const options = provider ? (catalog?.[provider]?.models ?? []) : [];
  if (!model || options.some((entry) => entry.value === model)) {
    return options;
  }
  return [
    {
      value: model,
      label: provider === 'CODEX' && model === 'default' ? 'Provider default' : model,
    },
    ...options,
  ];
}
function getUnavailableReason(
  defaultsLoading: boolean,
  error: string | undefined,
  native: SessionLaunchOptions | undefined,
  nativeError: string | undefined,
  invalidReasoning: boolean,
  invalidPlan: boolean,
  invalidAccess: boolean
) {
  if (error) {
    return error;
  }
  if (defaultsLoading) {
    return 'Loading chat defaults';
  }
  if (nativeError) {
    return nativeError;
  }
  if (!native) {
    return 'Loading thinking and planning options';
  }
  if (invalidReasoning) {
    return 'Choose a supported thinking level or Default';
  }
  if (invalidAccess) {
    return 'Choose a supported access mode';
  }
  if (invalidPlan) {
    return 'Turn Plan off because this model does not support it';
  }
  return undefined;
}

function useNativeLaunchOptions(
  provider: ChatProvider | null,
  model: string | undefined,
  enabled: boolean,
  codexAccountId?: string
) {
  const query = trpc.session.getLaunchOptions.useQuery(
    {
      provider: provider ?? 'CLAUDE',
      model,
      ...(provider === 'CODEX' && codexAccountId ? { codexAccountId } : {}),
    },
    { enabled: enabled && provider !== null, staleTime: 30_000, retry: false }
  );
  // The query is keyed by input; confirmed native IDs may differ from requested aliases.
  const native = query.data?.provider === provider ? query.data : undefined;
  const error = !native && query.error ? 'Could not load thinking and planning options' : undefined;
  return {
    native,
    error,
    loading: !(native || error),
    retry: () => {
      void query.refetch();
    },
  };
}

function getCodexAccountControl(
  provider: ChatProvider | null,
  accounts: readonly CodexAccountSummary[] | undefined,
  value: string | undefined,
  onChange: (id: string | undefined) => void
): SessionLaunchControlsProps['account'] {
  if (provider !== 'CODEX' || !accounts || (accounts.length <= 1 && !value)) {
    return undefined;
  }
  return { accounts, value, onChange };
}
function useCodexAccountControl(
  scopeKey: string | null,
  selection: Pick<
    ReturnType<typeof useSessionLaunchSelectionState>,
    'provider' | 'codexAccountId' | 'onCodexAccountChange'
  >
) {
  const { data: accounts } = trpc.codexAccounts.list.useQuery(undefined, {
    enabled: selection.provider === 'CODEX' && scopeKey !== null,
    staleTime: 30_000,
    retry: false,
  });
  return getCodexAccountControl(
    selection.provider,
    accounts,
    selection.codexAccountId,
    selection.onCodexAccountChange
  );
}
function getAccountInput(codexAccountId: string | undefined) {
  return codexAccountId ? { codexAccountId } : undefined;
}
export function useSessionLaunchSelection(
  scopeKey: string | null,
  options: {
    defaultProvider?: string | null;
    ready?: boolean;
    error?: string;
    onRetry?: () => void;
    snapshot?: SessionLaunchSelectionSnapshot;
    onChange?: (snapshot: SessionLaunchSelectionSnapshot) => void;
  } = {}
): SessionLaunchSelection {
  const {
    data: settings,
    error: settingsError,
    refetch: refetchSettings,
  } = trpc.userSettings.get.useQuery();
  const selection = useSessionLaunchSelectionState(
    scopeKey,
    settings && options.ready !== false
      ? {
          ...settings,
          defaultSessionProvider: resolveEffectiveSessionProvider(
            options.defaultProvider,
            settings.defaultSessionProvider
          ),
        }
      : undefined,
    options
  );
  const { data: catalog, isLoading: modelsLoading } = trpc.userSettings.getProviderOptions.useQuery(
    getAccountInput(selection.codexAccountId),
    {
      enabled: scopeKey !== null,
      staleTime: 60_000,
    }
  );
  const account = useCodexAccountControl(scopeKey, selection);
  const error =
    options.error ?? (!settings && settingsError ? 'Could not load chat defaults' : undefined);
  const loading = selection.loading && !error;
  const retry = () => {
    if (!settings && settingsError) {
      void refetchSettings();
    }
    options.onRetry?.();
  };
  const discovery = useNativeLaunchOptions(
    selection.provider,
    selection.model,
    scopeKey !== null && !selection.loading && !error,
    selection.codexAccountId
  );
  const { native, error: nativeError } = discovery;
  const effective = getEffectiveLaunchOptions(selection, native);
  const unavailableReason = getUnavailableReason(
    selection.loading,
    error,
    native,
    nativeError,
    effective.invalidReasoning,
    effective.invalidPlan,
    effective.invalidAccess
  );
  const ready = !unavailableReason;
  const models = getModels(selection.provider, selection.model, catalog);
  const pickerProps: ProviderModelPickerProps = {
    provider: selection.provider,
    model: selection.model,
    models,
    providerOptions: {
      CLAUDE: {
        defaultModel: selection.defaults?.defaultClaudeModel,
        models: getModels(
          'CLAUDE',
          selection.provider === 'CLAUDE'
            ? selection.model
            : selection.defaults?.defaultClaudeModel,
          catalog
        ),
      },
      CODEX: {
        defaultModel: selection.defaults?.defaultCodexModel,
        models: getModels(
          'CODEX',
          selection.provider === 'CODEX' ? selection.model : selection.defaults?.defaultCodexModel,
          catalog
        ),
      },
    },
    loading,
    error,
    onRetry: retry,
    modelsLoading,
    onProviderChange: selection.onProviderChange,
    onModelChange: selection.onModelChange,
    label: 'New conversation provider and model',
  };
  const controlsProps: SessionLaunchControlsProps = {
    ...pickerProps,
    account,
    ready,
    unavailableReason,
    ...getConfigurationControls(selection, discovery, effective),
  };
  return {
    snapshot: selection.snapshot,
    provider: selection.provider,
    model: selection.model,
    loading,
    ready,
    error,
    pickerProps,
    controlsProps,
    unavailableReason,
    creationDefaults: {
      provider: selection.provider ?? undefined,
      model: selection.model,
      ...(effective.accessMode !== undefined ? { accessMode: effective.accessMode } : {}),
      ...getAccountInput(selection.codexAccountId),
      reasoningEffort: effective.reasoningEffort ?? null,
      planModeEnabled: effective.planModeEnabled,
    },
    reset: selection.reset,
  };
}

function getConfigurationControls(
  selection: ReturnType<typeof useSessionLaunchSelectionState>,
  discovery: ReturnType<typeof useNativeLaunchOptions>,
  effective: ReturnType<typeof getEffectiveLaunchOptions>
): Pick<SessionLaunchControlsProps, 'reasoning' | 'accessMode' | 'planMode'> {
  const { native, error: nativeError, loading: nativeLoading } = discovery;
  return {
    reasoning: selection.provider
      ? {
          value: effective.reasoningEffort,
          options: native?.reasoning.options ?? [],
          defaultValue: native?.reasoning.defaultValue,
          loading: nativeLoading,
          error: nativeError,
          invalid: effective.invalidReasoning,
          onChange: selection.onReasoningChange,
          onRetry: discovery.retry,
        }
      : undefined,
    accessMode: selection.provider
      ? {
          value: effective.accessMode,
          options: native?.accessMode?.options ?? [],
          loading: nativeLoading,
          invalid: effective.invalidAccess,
          onChange: selection.onAccessModeChange,
        }
      : undefined,
    planMode: selection.provider
      ? {
          enabled: effective.planModeEnabled,
          supported: native?.planMode.supported ?? false,
          loading: nativeLoading,
          error: nativeError,
          onChange: selection.onPlanModeChange,
        }
      : undefined,
  };
}
