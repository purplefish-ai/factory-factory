import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { resolveEffectiveSessionProvider } from '@/lib/session-provider-selection';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';
import type { ProviderModelPickerProps } from './provider-model-picker';

export interface SessionLaunchDefaults {
  defaultSessionProvider: ChatProvider;
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
}

interface LaunchSelectionState {
  scopeKey: string | null;
  defaults: SessionLaunchDefaults | undefined;
  provider?: ChatProvider;
  models: Partial<Record<ChatProvider, string>>;
}

/** A draft owns a snapshot of saved defaults and its explicit per-provider choices. */
export function useSessionLaunchSelectionState(
  scopeKey: string | null,
  defaults: SessionLaunchDefaults | undefined
) {
  const [stored, setStored] = useState<LaunchSelectionState>(() => ({
    scopeKey,
    defaults,
    models: {},
  }));
  const committedDefaults = useRef({ scopeKey, defaults });
  useLayoutEffect(() => {
    committedDefaults.current = { scopeKey, defaults };
  }, [scopeKey, defaults]);
  const reset = useCallback(() => {
    const current = committedDefaults.current;
    setStored({ scopeKey: current.scopeKey, defaults: current.defaults, models: {} });
  }, []);
  let state = stored;
  if (stored.scopeKey !== scopeKey) {
    state = { scopeKey, defaults, models: {} };
    setStored(state);
  } else if (!stored.defaults && defaults) {
    state = { ...stored, defaults };
    setStored(state);
  }
  const provider = state.provider ?? state.defaults?.defaultSessionProvider ?? null;
  const model = provider
    ? (state.models[provider] ??
      (provider === 'CODEX'
        ? state.defaults?.defaultCodexModel
        : state.defaults?.defaultClaudeModel))
    : undefined;
  return {
    provider,
    model,
    loading: !state.defaults,
    onProviderChange: (next: ChatProvider) =>
      setStored((current) => ({ ...current, provider: next })),
    onModelChange: (next: string) => {
      if (provider) {
        setStored((current) => ({ ...current, models: { ...current.models, [provider]: next } }));
      }
    },
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
  creationDefaults: { provider?: ChatProvider; model?: string };
  reset: () => void;
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
  const catalogModels = selection.provider ? (catalog?.[selection.provider]?.models ?? []) : [];
  // A saved alias or custom value remains visible even before (or outside) catalog discovery.
  const models: readonly ChatModelOption[] =
    selection.model && !catalogModels.some((entry) => entry.value === selection.model)
      ? [
          {
            value: selection.model,
            label:
              selection.provider === 'CODEX' && selection.model === 'default'
                ? 'Provider default'
                : selection.model,
          },
          ...catalogModels,
        ]
      : catalogModels;
  return {
    provider: selection.provider,
    model: selection.model,
    loading,
    ready: !(selection.loading || error),
    error,
    pickerProps: {
      provider: selection.provider,
      model: selection.model,
      models,
      loading,
      error,
      onRetry: retry,
      modelsLoading,
      onProviderChange: selection.onProviderChange,
      onModelChange: selection.onModelChange,
      label: 'New conversation provider and model',
    },
    creationDefaults: { provider: selection.provider ?? undefined, model: selection.model },
    reset: selection.reset,
  };
}
