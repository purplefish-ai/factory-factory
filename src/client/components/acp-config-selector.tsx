import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
import type {
  AcpConfigOption,
  AcpConfigOptionGroup,
  AcpConfigOptionValue,
} from '@/client/lib/acp-config';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getConfigPresentation } from './acp-config-presentation';

interface AcpConfigSelectorProps {
  configOption: AcpConfigOption;
  onSelect: (configId: string, value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  invalid?: boolean;
}

function isGroupedOption(
  option: AcpConfigOptionValue | AcpConfigOptionGroup
): option is AcpConfigOptionGroup {
  return 'group' in option && Array.isArray(option.options);
}

function getToggleProps(
  next: AcpConfigOptionValue | undefined,
  active: boolean,
  onToggle: (value: string) => void,
  disabled?: boolean
) {
  return {
    'aria-pressed': active,
    disabled: disabled || !next,
    indicator: false,
    onClick: next ? () => onToggle(next.value) : undefined,
  };
}

/** Provider-owned settings, with compact controls and explanations at the point of selection. */
export function AcpConfigSelector({
  configOption,
  onSelect,
  disabled,
  compact = true,
  invalid = false,
}: AcpConfigSelectorProps) {
  const options = configOption.options.flatMap((entry) =>
    isGroupedOption(entry) ? entry.options : [entry]
  );
  const current = options.find((option) => option.value === configOption.currentValue);
  const next = options.find((option) => option.value !== configOption.currentValue);
  const displayName = current?.name ?? configOption.currentValue;
  const presentation = getConfigPresentation(configOption);
  const Icon = presentation.icon;
  const iconOnly = compact && presentation.compact;
  const label = `${presentation.label}: ${displayName}`;
  const trigger = (
    <ComposerMenuTrigger
      aria-label={label}
      aria-invalid={invalid || undefined}
      {...(presentation.toggle
        ? getToggleProps(
            next,
            presentation.active,
            (value) => onSelect(configOption.id, value),
            disabled
          )
        : { disabled })}
      iconOnly={iconOnly}
      icon={<ConfigOptionIcon invalid={invalid} Icon={Icon} />}

      className={cn(
        'shrink-0',
        presentation.active && 'bg-accent text-accent-foreground',
        presentation.warning &&
          'text-orange-600 hover:text-orange-600 dark:text-orange-400 dark:hover:text-orange-400',
        invalid &&
          'text-destructive hover:text-destructive dark:text-destructive dark:hover:text-destructive'
      )}
    >
      {displayName}
    </ComposerMenuTrigger>
  );
  const renderOption = (option: AcpConfigOptionValue) => {
    const item = getConfigPresentation({ ...configOption, currentValue: option.value });
    const ItemIcon = presentation.label === 'Access' ? item.icon : undefined;
    return (
      <DropdownMenuRadioItem
        key={option.value}
        value={option.value}
        textValue={option.name}
        className={cn(
          item.warning &&
            'text-orange-600 focus:text-orange-600 dark:text-orange-400 dark:focus:text-orange-400'
        )}
      >
        {ItemIcon && <ItemIcon className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0">
          <span className="block">{option.name}</span>
          {option.description && (
            <span className="block text-xs font-normal text-muted-foreground">
              {option.description}
            </span>
          )}
        </span>
      </DropdownMenuRadioItem>
    );
  };

  return (
    <TooltipProvider>
      <Tooltip open={compact ? undefined : false}>
        {presentation.toggle ? (
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        ) : (
          <DropdownMenu>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            </TooltipTrigger>
            <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
              <DropdownMenuLabel>{presentation.label}</DropdownMenuLabel>
              {configOption.description && (
                <p className="px-2 pb-2 text-xs text-muted-foreground">
                  {configOption.description}
                </p>
              )}
              <DropdownMenuRadioGroup
                value={configOption.currentValue}
                onValueChange={(value) => onSelect(configOption.id, value)}
              >
                {invalid && !current && (
                  <DropdownMenuRadioItem value={configOption.currentValue} disabled>
                    {displayName} (unavailable)
                  </DropdownMenuRadioItem>
                )}
                {configOption.options.map((entry, idx) =>
                  isGroupedOption(entry) ? (
                    <div key={entry.group}>
                      {idx > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel>{entry.group}</DropdownMenuLabel>
                      {entry.options.map(renderOption)}
                    </div>
                  ) : (
                    renderOption(entry)
                  )
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <TooltipContent side="top" className="max-w-64">
          <p>{label}</p>
          {(current?.description || configOption.description) && (
            <p className="mt-1 opacity-80">{current?.description || configOption.description}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ConfigOptionIcon({
  invalid,
  Icon,
}: {
  invalid: boolean;
  Icon: ReturnType<typeof getConfigPresentation>['icon'];
}) {
  if (invalid) {
    return <WarningCircleIcon className="size-3.5 shrink-0" aria-label="Unavailable access mode" />;
  }
  return Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null;
}
