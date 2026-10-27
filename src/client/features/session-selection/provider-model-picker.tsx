import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';

export interface ProviderModelPickerProps {
  provider: ChatProvider | null;
  model?: string;
  models: readonly ChatModelOption[];
  onModelChange?: (model: string) => void;
  onProviderChange?: (provider: ChatProvider) => void;
  loading?: boolean;
  modelsLoading?: boolean;
  updating?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
}

function getDisabledReason(unavailable: boolean, loading: boolean, reason?: string) {
  if (!unavailable) {
    return undefined;
  }
  return reason ?? (loading ? 'Loading model options' : undefined);
}

/** Selection is controlled by the caller; this component never discovers or substitutes a model. */
export function ProviderModelPicker({
  provider,
  model,
  models,
  onModelChange,
  onProviderChange,
  loading = false,
  modelsLoading = false,
  updating = false,
  disabled = false,
  disabledReason,
  label = 'Provider and model',
}: ProviderModelPickerProps) {
  const providerName = provider === 'CODEX' ? 'Codex' : provider === 'CLAUDE' ? 'Claude' : null;
  const modelName = loading
    ? 'Loading model…'
    : (models.find((option) => option.value === model)?.label ?? model ?? 'Select model');
  const displayName = providerName ? `${providerName} · ${modelName}` : modelName;
  const canChange = Boolean(onProviderChange || (onModelChange && models.length > 0));
  const unavailable = disabled || loading || !canChange;
  const reason = getDisabledReason(unavailable, loading, disabledReason);

  return (
    <DropdownMenu>
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
          className="h-6 min-w-0 max-w-[14rem] shrink gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
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
        {onProviderChange && (
          <>
            <DropdownMenuLabel>Provider for new conversation</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={provider ?? ''}
              onValueChange={(value) => {
                if (value === 'CLAUDE' || value === 'CODEX') {
                  onProviderChange(value);
                }
              }}
            >
              <DropdownMenuRadioItem value="CLAUDE">Claude</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="CODEX">Codex</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {modelsLoading && (
          <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading models…
          </div>
        )}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
