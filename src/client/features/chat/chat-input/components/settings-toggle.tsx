import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { ShortcutKeys } from '@/client/features/shortcuts';
import { type ShortcutId } from '@/client/lib/keyboard-shortcuts';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SettingsToggleProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
  icon: Icon;
  label: string;
  ariaLabel: string;
  /** Registry shortcut shown in the tooltip for use while typing. */
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
        <p className="flex items-center gap-2">
          <span>
            {label} {pressed ? '(on)' : '(off)'}
          </span>
          {shortcutId && (
            <span className="inline-flex items-center gap-1">
              In composer <ShortcutKeys id={shortcutId} all />
            </span>
          )}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
