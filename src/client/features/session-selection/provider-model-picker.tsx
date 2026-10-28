import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  updating?: boolean;
  error?: string;
  onRetry?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
}

const PROVIDER_NAMES = { CLAUDE: 'Claude', CODEX: 'Codex' };

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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={unavailable}
          aria-label={`${label}: ${displayName}`}
          aria-description={reason}
          aria-busy={updating}
          title={reason ?? displayName}
          className="h-7 min-w-0 max-w-[14rem] shrink gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{displayName}</span>
          {updating ? (
            <SpinnerGapIcon
              role="status"
              aria-label="Applying model selection"
              className="h-3 w-3 shrink-0 animate-spin"
            />
          ) : (
            <CaretDownIcon className="h-3 w-3 shrink-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{onProviderChange ? 'Provider and model' : 'Model'}</DropdownMenuLabel>
        {modelsLoading && (
          <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading models…
          </div>
        )}
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
