import { useCallback, useState } from 'react';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import { QUERY_RETRY } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { useProviderOptions, useUserSettings } from '@/client/lib/user-settings-queries';
import { resolveEffectiveSessionProvider } from '@/lib/session-provider-selection';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';
import type { CodexAccountSummary } from '@/shared/codex-accounts';
import type { SessionPermissionPreset } from '@/shared/core';
import type { SessionLaunchSettings } from '@/shared/session-launch';
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
  const committedInputs = useLatestRef({ scopeKey, defaults, restoration });
  const reset = useCallback(() => {
    const current = committedInputs.current;
    const snapshot = { defaults: current.defaults, drafts: {} };
    const next: LaunchSelectionState = {
      ...snapshot,
      scopeKey: current.scopeKey,
      // Remember the consumed external snapshot so reset cannot restore its old choices.
      restoredSnapshot: current.restoration.snapshot,
    };
    latestState.current = next;
    setStored(next);
    current.restoration.onChange?.(snapshot);
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
  // Updates write ahead so a second update in the same event builds on the first.
  const latestState = useLatestRef(state);
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
type EffectiveLaunchOptions = ReturnType<typeof getEffectiveLaunchOptions>;
/**
 * Thinking and planning options never block creation: without options
 * confirmed for the selected model, the session starts with saved defaults.
 */
function getUnavailableReason(
  defaultsLoading: boolean,
  error: string | undefined,
  confirmed: EffectiveLaunchOptions | undefined
) {
  if (error) {
    return error;
  }
  if (defaultsLoading) {
    return 'Loading chat defaults';
  }
  if (confirmed?.invalidReasoning) {
    return 'Choose a supported thinking level or Default';
  }
  if (confirmed?.invalidAccess) {
    return 'Choose a supported access mode';
  }
  if (confirmed?.invalidPlan) {
    return 'Turn Plan off because this model does not support it';
  }
  return undefined;
}

/**
 * Confirmed options produce the full launch payload. Otherwise only explicit
 * choices are sent, and the server applies saved defaults to the rest.
 */
function getLaunchSettings(
  selection: Pick<
    ReturnType<typeof useSessionLaunchSelectionState>,
    'accessMode' | 'reasoningEffort' | 'planModeEnabled'
  >,
  confirmed: EffectiveLaunchOptions | undefined
): SessionLaunchSettings {
  if (confirmed) {
    return {
      ...(confirmed.accessMode !== undefined ? { accessMode: confirmed.accessMode } : {}),
      reasoningEffort: confirmed.reasoningEffort ?? null,
      planModeEnabled: confirmed.planModeEnabled,
    };
  }
  const { accessMode, reasoningEffort, planModeEnabled } = selection;
  return {
    ...(accessMode !== undefined ? { accessMode } : {}),
    ...(reasoningEffort !== undefined
      ? { reasoningEffort: reasoningEffort === 'default' ? null : reasoningEffort }
      : {}),
    ...(planModeEnabled !== undefined ? { planModeEnabled } : {}),
  };
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
    {
      enabled: enabled && provider !== null,
      staleTime: 30_000,
      retry: QUERY_RETRY.costlyRead,
      // Keep showing the last options while another model's cached options load.
      placeholderData: (previous) => (previous?.provider === provider ? previous : undefined),
    }
  );
  // The query is keyed by input; confirmed native IDs may differ from requested aliases.
  const native = query.data?.provider === provider ? query.data : undefined;
  const error = !native && query.error ? "Couldn't load thinking and planning options" : undefined;
  return {
    native,
    /** Options discovered for the selected model, not a placeholder from the last one. */
    confirmed: native !== undefined && !query.isPlaceholderData,
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
    retry: QUERY_RETRY.costlyRead,
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
  const { data: settings, error: settingsError, refetch: refetchSettings } = useUserSettings();
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
  const {
    data: catalog,
    isLoading: modelsLoading,
    error: catalogError,
    refetch: refetchCatalog,
  } = useProviderOptions(getAccountInput(selection.codexAccountId), {
    enabled: scopeKey !== null,
  });
  const account = useCodexAccountControl(scopeKey, selection);
  const error =
    options.error ?? (!settings && settingsError ? "Couldn't load chat defaults" : undefined);
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
  const effective = getEffectiveLaunchOptions(selection, discovery.native);
  const confirmed = discovery.confirmed ? effective : undefined;
  const unavailableReason = getUnavailableReason(selection.loading, error, confirmed);
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
    // Cached models stay usable when only a refetch failed.
    modelsError: catalog ? undefined : catalogError?.message,
    onRetryModels: () => {
      void refetchCatalog();
    },
    onProviderChange: selection.onProviderChange,
    onModelChange: selection.onModelChange,
    label: 'New conversation provider and model',
  };
  const controlsProps: SessionLaunchControlsProps = {
    ...pickerProps,
    account,
    ready,
    unavailableReason,
    ...getConfigurationControls(selection, discovery, effective, confirmed),
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
      ...getAccountInput(selection.codexAccountId),
      ...getLaunchSettings(selection, confirmed),
    },
    reset: selection.reset,
  };
}

function getConfigurationControls(
  selection: ReturnType<typeof useSessionLaunchSelectionState>,
  discovery: ReturnType<typeof useNativeLaunchOptions>,
  effective: EffectiveLaunchOptions,
  confirmed: EffectiveLaunchOptions | undefined
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
          invalid: confirmed?.invalidReasoning ?? false,
          onChange: selection.onReasoningChange,
          onRetry: discovery.retry,
        }
      : undefined,
    accessMode: selection.provider
      ? {
          value: effective.accessMode,
          options: native?.accessMode?.options ?? [],
          loading: nativeLoading,
          invalid: confirmed?.invalidAccess ?? false,
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
