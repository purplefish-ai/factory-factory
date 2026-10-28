import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { ReactNode } from 'react';
import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  children?: ReactNode;
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
        <ComposerMenuTrigger
          className={cn('max-w-[8rem] shrink-0', control.invalid && 'text-destructive')}
          disabled={disabled || unsupported}
          aria-label={`Thinking level: ${label}`}
          aria-description={description}
          title={description}
          aria-busy={control.loading}
          aria-invalid={control.invalid}
          indicator={
            control.invalid ? (
              <>
                <WarningCircleIcon
                  className="size-3 shrink-0"
                  aria-label="Unavailable thinking level"
                />
                <CaretDownIcon className="size-3 shrink-0" />
              </>
            ) : undefined
          }
        >
          {label}
        </ComposerMenuTrigger>
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
function PlanningSelector({
  control,
  disabled,
  disabledReason,
}: {
  control: LaunchPlanControl;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const unavailable =
    !control.enabled && (control.loading || Boolean(control.error) || !control.supported);
  const description = disabled ? disabledReason : getPlanDescription(control);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ComposerMenuTrigger
          disabled={disabled || unavailable}
          aria-label={`Planning: ${control.enabled ? 'Plan' : 'Default'}`}
          aria-description={description}
          title={description}
        >
          {control.enabled ? 'Plan' : 'Default'}
        </ComposerMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Planning</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={control.enabled ? 'plan' : 'default'}
          onValueChange={(value) => control.onChange(value === 'plan')}
        >
          <DropdownMenuRadioItem value="default">Default</DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="plan"
            disabled={control.loading || Boolean(control.error) || !control.supported}
          >
            Plan
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
/** Pure shared launch controls; native discovery and draft ownership live in the caller's hook. */
export function SessionLaunchControls({
  reasoning,
  planMode,
  children,
  ...picker
}: SessionLaunchControlsProps) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <ProviderModelPicker {...picker} />
      {reasoning && (
        <ThinkingLevelSelector
          control={reasoning}
          disabled={picker.disabled}
          disabledReason={picker.disabledReason}
        />
      )}
      {planMode && (
        <PlanningSelector
          control={planMode}
          disabled={picker.disabled}
          disabledReason={picker.disabledReason}
        />
      )}
      {children}
    </div>
  );
}
