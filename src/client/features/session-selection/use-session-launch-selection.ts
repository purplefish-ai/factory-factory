import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { resolveEffectiveSessionProvider } from '@/lib/session-provider-selection';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';
import type { SessionLaunchOptions, SessionLaunchSettings } from '@/shared/session-launch';
import { getEffectiveLaunchOptions } from './launch-options-state';
import type { ProviderModelPickerProps } from './provider-model-picker';
import type { SessionLaunchControlsProps } from './session-launch-controls';

export interface SessionLaunchDefaults {
  defaultSessionProvider: ChatProvider;
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
}

interface ProviderDraft {
  model?: string;
  reasoningEffort?: string | null;
  planModeEnabled?: boolean;
}
interface LaunchSelectionState {
  scopeKey: string | null;
  defaults: SessionLaunchDefaults | undefined;
  provider?: ChatProvider;
  drafts: Partial<Record<ChatProvider, ProviderDraft>>;
}

/** A draft owns a snapshot of saved defaults and its explicit per-provider choices. */
export function useSessionLaunchSelectionState(
  scopeKey: string | null,
  defaults: SessionLaunchDefaults | undefined
) {
  const [stored, setStored] = useState<LaunchSelectionState>(() => ({
    scopeKey,
    defaults,
    drafts: {},
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
  if (stored.scopeKey !== scopeKey) {
    state = { scopeKey, defaults, drafts: {} };
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
  const updateDraft = (patch: Partial<ProviderDraft>) => {
    if (provider) {
      setStored((current) => ({
        ...current,
        drafts: { ...current.drafts, [provider]: { ...current.drafts[provider], ...patch } },
      }));
    }
  };
  return {
    provider,
    model,
    savedReasoningEffort,
    reasoningEffort: draft?.reasoningEffort,
    planModeEnabled: draft?.planModeEnabled,
    loading: !state.defaults,
    defaults: state.defaults,
    onProviderChange: (next: ChatProvider, model?: string) =>
      setStored((current) => ({
        ...current,
        provider: next,
        drafts: { ...current.drafts, [next]: { ...current.drafts[next], model } },
      })),
    onModelChange: (model: string) => updateDraft({ model }),
    onReasoningChange: (reasoningEffort: string | null) => updateDraft({ reasoningEffort }),
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
  creationDefaults: SessionLaunchSettings & { provider?: ChatProvider; model?: string };
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
  invalidPlan: boolean
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
  if (invalidPlan) {
    return 'Turn Plan off because this model does not support it';
  }
  return undefined;
}

function useNativeLaunchOptions(
  provider: ChatProvider | null,
  model: string | undefined,
  enabled: boolean
) {
  const query = trpc.session.getLaunchOptions.useQuery(
    { provider: provider ?? 'CLAUDE', model },
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

export function useSessionLaunchSelection(
  scopeKey: string | null,
  options: {
    defaultProvider?: string | null;
    ready?: boolean;
    error?: string;
    onRetry?: () => void;
  } = {}
): SessionLaunchSelection {
  const {
    data: settings,
    error: settingsError,
    refetch: refetchSettings,
  } = trpc.userSettings.get.useQuery();
  const { data: catalog, isLoading: modelsLoading } = trpc.userSettings.getProviderOptions.useQuery(
    undefined,
    {
      enabled: scopeKey !== null,
      staleTime: 60_000,
    }
  );
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
      : undefined
  );
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
    scopeKey !== null && !selection.loading && !error
  );
  const { native, error: nativeError, loading: nativeLoading } = discovery;
  const effective = getEffectiveLaunchOptions(selection, native);
  const unavailableReason = getUnavailableReason(
    selection.loading,
    error,
    native,
    nativeError,
    effective.invalidReasoning,
    effective.invalidPlan
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
    ready,
    unavailableReason,
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
  return {
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
      reasoningEffort: effective.reasoningEffort ?? null,
      planModeEnabled: effective.planModeEnabled,
    },
    reset: selection.reset,
  };
}
