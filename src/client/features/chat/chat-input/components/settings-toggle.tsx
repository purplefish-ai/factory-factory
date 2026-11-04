import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { ShortcutKeys } from '@/client/features/shortcuts';
import { getAriaKeyShortcuts, type ShortcutId } from '@/client/lib/keyboard-shortcuts';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SettingsToggleProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
  icon: Icon;
  label: string;
  ariaLabel: string;
  /** Registry shortcut shown in the tooltip and exposed as `aria-keyshortcuts`. */
  shortcutId?: ShortcutId;
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
  shortcutId,
}: SettingsToggleProps) {
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
            aria-keyshortcuts={shortcutId ? getAriaKeyShortcuts(shortcutId) : undefined}
          >
            <Icon className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="flex items-center gap-2">
            <span>
              {label} {pressed ? '(on)' : '(off)'}
            </span>
            {shortcutId && <ShortcutKeys id={shortcutId} />}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
