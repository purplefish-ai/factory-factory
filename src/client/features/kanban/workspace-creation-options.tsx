import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip';
import type { ReactNode } from 'react';
import {
  SessionLaunchControls,
  type SessionLaunchControlsProps,
} from '@/client/features/session-selection';
import { RatchetToggleButton } from '@/client/features/workspace';
import { Button } from '@/components/ui/button';

/** Keep model settings and workspace actions in stable groups at sidebar widths. */
export function WorkspaceCreationOptions({
  selection,
  enabled,
  disabled,
  settingsLoading,
  ratchetEnabled,
  onRatchetChange,
  onAttach,
  children,
}: {
  selection: SessionLaunchControlsProps;
  enabled: boolean;
  disabled: boolean;
  settingsLoading: boolean;
  ratchetEnabled: boolean;
  onRatchetChange: (value: boolean) => void;
  onAttach: () => void;
  children: ReactNode;
}) {
  const disabledReason = disabled ? 'Creating workspace' : undefined;
  return (
    <div className="space-y-2">
      {enabled && (
        <SessionLaunchControls {...selection} disabled={disabled} disabledReason={disabledReason} />
      )}
      <div className="flex items-center justify-between gap-2">
        {enabled && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 px-0"
              aria-label="Attach files"
              onClick={onAttach}
              disabled={disabled}
            >
              <PaperclipIcon className="h-3.5 w-3.5" />
            </Button>
            <RatchetToggleButton
              enabled={ratchetEnabled}
              state="IDLE"
              onToggle={onRatchetChange}
              disabled={settingsLoading || disabled}
            />
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}
