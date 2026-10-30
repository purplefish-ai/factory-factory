import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { ReactNode } from 'react';
import { AcpConfigSelector } from '@/client/components/acp-config-selector';
import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
import { CodexAccountPicker, type CodexAccountPickerProps } from '@/client/features/codex-accounts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
export interface LaunchAccessControl {
  value?: string;
  options: readonly ChatReasoningOption[];
  loading: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}
export interface LaunchPlanControl {
  enabled: boolean;
  supported: boolean;
  loading: boolean;
  error?: string;
  onChange: (value: boolean) => void;
}
export interface SessionLaunchControlsProps extends ProviderModelPickerProps {
  className?: string;
  children?: ReactNode;
  account?: Omit<CodexAccountPickerProps, 'disabled'>;
  reasoning?: LaunchReasoningControl;
  planMode?: LaunchPlanControl;
  accessMode?: LaunchAccessControl;
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
          icon={<BrainIcon className="size-3.5 shrink-0" aria-hidden="true" />}
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
export function PlanningSelector({
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
  const stateLabel = control.enabled ? 'On' : 'Off';
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <ComposerMenuTrigger
            iconOnly={!showLabel}
            indicator={false}
            icon={<MapTrifoldIcon className="size-3.5 shrink-0" aria-hidden="true" />}
            className={cn('shrink-0', control.enabled && 'bg-accent text-accent-foreground')}
            disabled={disabled || unavailable}
            aria-label={`Planning: ${stateLabel}`}
            aria-description={description}
            aria-pressed={control.enabled}
            onClick={() => control.onChange(!control.enabled)}
          >
            {stateLabel}
          </ComposerMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function AccessModeSelector({
  control,
  disabled,
  compact = true,
}: {
  control: LaunchAccessControl;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <AcpConfigSelector
      compact={compact}
      invalid={control.invalid}
      configOption={{
        id: 'mode',
        name: 'Access',
        description: control.invalid
          ? 'Selected access mode is unavailable. Choose a supported mode.'
          : undefined,
        type: 'select',
        currentValue: control.value ?? (control.loading ? 'Loading…' : ''),
        options: control.options.map((option) => ({
          value: option.value,
          name: option.label,
          description: option.description,
        })),
      }}
      disabled={disabled || control.loading || !control.options.length}
      onSelect={(_id, value) => control.onChange(value)}
    />
  );
}
/** Pure shared launch controls; native discovery and draft ownership live in the caller's hook. */
export function SessionLaunchControls({
  reasoning,
  account,
  planMode,
  accessMode,
  children,
  className,
  ...picker
}: SessionLaunchControlsProps) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      <ProviderModelPicker {...picker} />
      {picker.provider === 'CODEX' && account && (
        <CodexAccountPicker {...account} disabled={picker.disabled} />
      )}
      {reasoning && (
        <ThinkingLevelSelector
          control={reasoning}
          disabled={picker.disabled}
          disabledReason={picker.disabledReason}
        />
      )}
      {accessMode && <AccessModeSelector control={accessMode} disabled={picker.disabled} />}
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
