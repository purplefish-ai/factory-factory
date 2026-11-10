import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { useState } from 'react';
import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';
import { ProviderModelSubmenu } from './provider-model-submenu';

export interface ProviderModelOptions {
  defaultModel?: string;
  models: readonly ChatModelOption[];
}

export interface ProviderModelPickerProps {
  provider: ChatProvider | null;
  model?: string;
  models: readonly ChatModelOption[];
  onModelChange?: (model: string) => void;
  onProviderChange?: (provider: ChatProvider, model?: string) => void;
  providerOptions?: Partial<Record<ChatProvider, ProviderModelOptions>>;
  loading?: boolean;
  modelsLoading?: boolean;
  /** The model catalog failed to load; the menu says so instead of listing no models. */
  modelsError?: string;
  onRetryModels?: () => void;
  updating?: boolean;
  error?: string;
  onRetry?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
}

const PROVIDER_NAMES = { CLAUDE: 'Claude', CODEX: 'Codex' };

function ModelsErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <>
      <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
        Couldn't load models. {message}
      </p>
      {onRetry ? (
        <DropdownMenuItem
          className="text-xs"
          onSelect={(event) => {
            event.preventDefault();
            onRetry();
          }}
        >
          <ArrowClockwiseIcon className="size-3.5" aria-hidden="true" />
          Retry
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function getDisabledReason(unavailable: boolean, loading: boolean, reason?: string) {
  if (!unavailable) {
    return undefined;
  }
  return reason ?? (loading ? 'Loading model options' : undefined);
}

function SelectionRetry({
  error,
  onRetry,
  disabled,
  disabledReason,
  label,
}: {
  error: string;
  onRetry?: () => void;
  disabled: boolean;
  disabledReason?: string;
  label: string;
}) {
  const reason = disabled ? disabledReason : undefined;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-2 text-xs text-muted-foreground"
      disabled={disabled || !onRetry}
      onClick={onRetry}
      title={reason ?? error}
      aria-description={reason}
      aria-label={`${label}: ${error}. Retry selection`}
    >
      <ArrowClockwiseIcon className="h-3 w-3 shrink-0" />
      <span>Retry selection</span>
    </Button>
  );
}

/** Selection is controlled by the caller; this component never discovers or substitutes a model. */
export function ProviderModelPicker({
  provider,
  model,
  models,
  onModelChange,
  onProviderChange,
  providerOptions,
  loading = false,
  modelsLoading = false,
  modelsError,
  onRetryModels,
  updating = false,
  error,
  onRetry,
  disabled = false,
  disabledReason,
  label = 'Provider and model',
}: ProviderModelPickerProps) {
  const [open, setOpen] = useState(false);
  if (error) {
    return (
      <SelectionRetry
        error={error}
        onRetry={onRetry}
        disabled={disabled}
        disabledReason={disabledReason}
        label={label}
      />
    );
  }
  const providerName = provider ? PROVIDER_NAMES[provider] : null;
  const modelName = loading
    ? 'Loading model…'
    : (models.find((option) => option.value === model)?.label ?? model ?? 'Select model');
  const displayName = providerName ? `${providerName} · ${modelName}` : modelName;
  const canChange = Boolean(onProviderChange || (onModelChange && models.length > 0));
  const unavailable = disabled || loading || !canChange;
  const reason = getDisabledReason(unavailable, loading, disabledReason);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <ComposerMenuTrigger
          disabled={unavailable}
          aria-label={`${label}: ${displayName}`}
          aria-description={reason}
          aria-busy={updating}
          title={reason ?? displayName}
          className="shrink"
          indicator={
            updating ? (
              <Spinner role="status" aria-label="Applying model selection" className="size-3" />
            ) : undefined
          }
        >
          {modelName}
        </ComposerMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{onProviderChange ? 'Provider and model' : 'Model'}</DropdownMenuLabel>
        {modelsLoading && (
          <div
            role="status"
            className="inline-flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
          >
            <Spinner className="size-3" aria-hidden="true" />
            Loading models…
          </div>
        )}
        {modelsError ? <ModelsErrorRow message={modelsError} onRetry={onRetryModels} /> : null}
        {onProviderChange ? (
          (['CLAUDE', 'CODEX'] as const).map((value) => (
            <ProviderModelSubmenu
              key={value}
              name={PROVIDER_NAMES[value]}
              selected={provider === value}
              model={provider === value ? model : undefined}
              options={providerOptions?.[value] ?? { models: provider === value ? models : [] }}
              loading={modelsLoading}
              onSelect={(nextModel) => {
                onProviderChange(value, nextModel);
                setOpen(false);
              }}
            />
          ))
        ) : (
          <DropdownMenuRadioGroup value={model ?? ''} onValueChange={onModelChange}>
            {models.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={!onModelChange}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
