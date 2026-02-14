import { ChevronDown } from 'lucide-react';
import type {
  AcpConfigOption,
  AcpConfigOptionGroup,
  AcpConfigOptionValue,
} from '@/components/chat/reducer';
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

interface AcpConfigSelectorProps {
  configOption: AcpConfigOption;
  onSelect: (configId: string, value: string) => void;
  disabled?: boolean;
}

function isGroupedOption(
  option: AcpConfigOptionValue | AcpConfigOptionGroup
): option is AcpConfigOptionGroup {
  return 'group' in option && Array.isArray((option as AcpConfigOptionGroup).options);
}

function findCurrentLabel(configOption: AcpConfigOption): string {
  for (const entry of configOption.options) {
    if (isGroupedOption(entry)) {
      for (const opt of entry.options) {
        if (opt.value === configOption.currentValue) {
          return opt.name;
        }
      }
    } else if (entry.value === configOption.currentValue) {
      return entry.name;
    }
  }
  return configOption.name;
}

/**
 * Generic ACP config option dropdown selector.
 * Handles both flat and grouped option arrays from ACP agents.
 * Follows the same visual style as ModelSelector.
 */
export function AcpConfigSelector({ configOption, onSelect, disabled }: AcpConfigSelectorProps) {
  const displayName = findCurrentLabel(configOption);
  const hasGroupedOptions = configOption.options.some(isGroupedOption);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {displayName}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={configOption.currentValue}
          onValueChange={(value) => onSelect(configOption.id, value)}
        >
          {hasGroupedOptions
            ? configOption.options.map((entry, idx) => {
                if (isGroupedOption(entry)) {
                  return (
                    <div key={entry.group}>
                      {idx > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel>{entry.group}</DropdownMenuLabel>
                      {entry.options.map((opt) => (
                        <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                          {opt.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </div>
                  );
                }
                return (
                  <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                    {entry.name}
                  </DropdownMenuRadioItem>
                );
              })
            : configOption.options.map((entry) => {
                const opt = entry as AcpConfigOptionValue;
                return (
                  <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                    {opt.name}
                  </DropdownMenuRadioItem>
                );
              })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
