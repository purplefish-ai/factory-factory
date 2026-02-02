import type { LucideIcon } from 'lucide-react';

import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SettingsToggleProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  ariaLabel: string;
  shortcut?: string;
  showShortcut?: boolean;
}

/**
 * Generic toggle button with tooltip for settings.
 * Used for ThinkingToggle and PlanModeToggle.
 */
export function SettingsToggle({
  pressed,
  onPressedChange,
  disabled,
  icon: Icon,
  label,
  ariaLabel,
  shortcut,
  showShortcut = false,
}: SettingsToggleProps) {
  const shortcutText = showShortcut && shortcut ? ` (${shortcut})` : '';
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            pressed={pressed}
            onPressedChange={onPressedChange}
            disabled={disabled}
            size="sm"
            className={cn(
              'h-6 w-6 p-0',
              pressed &&
                'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
            )}
            aria-label={ariaLabel}
          >
            <Icon className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>
            {label} {pressed ? '(on)' : '(off)'}
            {shortcutText}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
