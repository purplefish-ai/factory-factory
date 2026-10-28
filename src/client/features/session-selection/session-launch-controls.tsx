import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
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
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ChatReasoningOption } from '@/shared/chat-capabilities';
import { ProviderModelPicker, type ProviderModelPickerProps } from './provider-model-picker';

export interface LaunchReasoningControl {
  value?: string | null;
  options: readonly ChatReasoningOption[];
  defaultValue?: string;
  loading: boolean;
  error?: string;
  invalid: boolean;
  onChange: (value: string | null) => void;
  onRetry: () => void;
}
export interface LaunchPlanControl {
  enabled: boolean;
  supported: boolean;
  loading: boolean;
  error?: string;
  onChange: (value: boolean) => void;
}
export interface SessionLaunchControlsProps extends ProviderModelPickerProps {
  reasoning?: LaunchReasoningControl;
  planMode?: LaunchPlanControl;
  ready?: boolean;
  unavailableReason?: string;
}
const NATIVE_DEFAULT = '__native_default__';
function getThinkingLabel(control: LaunchReasoningControl): string {
  if (control.value === null) {
    return 'Default';
  }
  if (control.value !== undefined) {
    return control.options.find((option) => option.value === control.value)?.label ?? control.value;
  }
  if (control.loading) {
    return 'Loading…';
  }
  if (control.error) {
    return 'Unavailable';
  }
  return 'Default';
}
function getThinkingDescription(control: LaunchReasoningControl): string {
  if (control.invalid) {
    return 'Selected thinking level is unavailable. Choose a supported level or Default.';
  }
  if (control.error) {
    return control.error;
  }
  if (control.loading) {
    return 'Loading thinking levels';
  }
  if (!control.options.length) {
    return 'Thinking levels are not supported by this model';
  }
  return 'Thinking level';
}
function ThinkingLevelSelector({
  control,
  disabled,
  disabledReason,
}: {
  control: LaunchReasoningControl;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const label = getThinkingLabel(control);
  const description = disabled ? disabledReason : getThinkingDescription(control);
  const unsupported = !(
    control.options.length ||
    control.loading ||
    control.error ||
    control.invalid
  );
  const unlisted =
    typeof control.value === 'string' &&
    !control.options.some((option) => option.value === control.value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 min-w-0 max-w-[8rem] shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground',
            control.invalid && 'text-destructive'
          )}
          disabled={disabled || unsupported}
          aria-label={`Thinking level: ${label}`}
          aria-description={description}
          title={description}
          aria-busy={control.loading}
          aria-invalid={control.invalid}
        >
          <BrainIcon className="h-3.5 w-3.5" />
          <span className="truncate">{label}</span>
          {control.invalid && (
            <WarningCircleIcon
              className="h-3 w-3 shrink-0"
              aria-label="Unavailable thinking level"
            />
          )}
          <CaretDownIcon className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Thinking level</DropdownMenuLabel>
        {control.loading && (
          <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading thinking levels…
          </div>
        )}
        {control.error && (
          <DropdownMenuItem onClick={control.onRetry}>Retry thinking options</DropdownMenuItem>
        )}
        <DropdownMenuRadioGroup
          value={control.value === null ? NATIVE_DEFAULT : (control.value ?? '')}
          onValueChange={(value) => control.onChange(value === NATIVE_DEFAULT ? null : value)}
        >
          <DropdownMenuRadioItem
            value={NATIVE_DEFAULT}
            title={
              control.defaultValue
                ? `Provider default: ${control.defaultValue}`
                : 'Provider default'
            }
          >
            Default
          </DropdownMenuRadioItem>
          {unlisted && (
            <DropdownMenuRadioItem value={String(control.value)} disabled>
              {control.value} {control.invalid ? '(unavailable)' : '(selected)'}
            </DropdownMenuRadioItem>
          )}
          {control.options
            .filter((option) => option.value !== 'default')
            .map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                title={option.description}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function getPlanDescription(control: LaunchPlanControl): string {
  if (control.loading) {
    return 'Loading planning options';
  }
  if (control.error) {
    return control.error;
  }
  if (!control.supported) {
    return control.enabled
      ? 'Plan is not supported by this model. Turn Plan off to launch.'
      : 'Plan is not supported by this model';
  }
  return `Plan mode ${control.enabled ? 'on' : 'off'}`;
}
export function PlanModeToggle({
  control,
  disabled,
  disabledReason,
  showLabel = false,
}: {
  control: LaunchPlanControl;
  disabled?: boolean;
  disabledReason?: string;
  showLabel?: boolean;
}) {
  const unavailable =
    !control.enabled && (control.loading || Boolean(control.error) || !control.supported);
  const description = disabled ? disabledReason : getPlanDescription(control);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={control.enabled}
            onPressedChange={control.onChange}
            disabled={disabled || unavailable}
            aria-label="Plan mode"
            aria-description={description}
            className={cn(
              'h-7 shrink-0 gap-1.5 text-xs disabled:pointer-events-auto data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
              showLabel ? 'px-2' : 'w-7 p-0'
            )}
          >
            <MapTrifoldIcon className="h-3.5 w-3.5" />
            {showLabel && <span>Plan</span>}
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
/** Pure shared launch controls; native discovery and draft ownership live in the caller's hook. */
export function SessionLaunchControls({
  reasoning,
  planMode,
  ...picker
}: SessionLaunchControlsProps) {
  return (
    <div className="flex min-w-0 max-w-[min(26rem,calc(100vw-4rem))] flex-wrap items-center gap-1">
      <ProviderModelPicker {...picker} />
      {reasoning && (
        <ThinkingLevelSelector
          control={reasoning}
          disabled={picker.disabled}
          disabledReason={picker.disabledReason}
        />
      )}
      {planMode && (
        <PlanModeToggle
          control={planMode}
          disabled={picker.disabled}
          disabledReason={picker.disabledReason}
        />
      )}
    </div>
  );
}
