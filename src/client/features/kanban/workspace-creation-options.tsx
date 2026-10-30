import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { ReactNode } from 'react';
import { getConfigPresentation } from '@/client/components/acp-config-presentation';
import { CodexAccountPicker } from '@/client/features/codex-accounts';
import {
  AccessModeSelector,
  PlanningSelector,
  SessionLaunchControls,
  type SessionLaunchControlsProps,
} from '@/client/features/session-selection';
import { RatchetToggleButton } from '@/client/features/workspace';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

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
    <div className="space-y-1">
      {enabled && (
        <SessionLaunchControls
          {...selection}
          account={undefined}
          accessMode={undefined}
          planMode={undefined}
          className="flex-nowrap"
          disabled={disabled}
          disabledReason={disabledReason}
        />
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
            <WorkspaceSettings
              selection={selection}
              disabled={disabled}
              settingsLoading={settingsLoading}
              ratchetEnabled={ratchetEnabled}
              onRatchetChange={onRatchetChange}
            />
          </div>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

function WorkspaceSettings({
  selection,
  disabled,
  settingsLoading,
  ratchetEnabled,
  onRatchetChange,
}: {
  selection: SessionLaunchControlsProps;
  disabled: boolean;
  settingsLoading: boolean;
  ratchetEnabled: boolean;
  onRatchetChange: (value: boolean) => void;
}) {
  const { account, accessMode, planMode } = selection;
  const disabledReason = disabled ? 'Creating workspace' : undefined;
  const { invalid, active, description } = getSettingsStatus(selection, ratchetEnabled);
  const { warning } = getConfigPresentation({
    id: 'mode',
    name: 'Access',
    type: 'select',
    currentValue: accessMode?.value ?? '',
    options: [],
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'relative h-7 w-7 shrink-0 px-0 text-muted-foreground',
            active && 'text-foreground',
            warning && 'text-orange-600 dark:text-orange-400',
            invalid && 'text-destructive'
          )}
          aria-label="Workspace settings"
          aria-description={description}
          aria-invalid={invalid || undefined}
          title={description || 'Workspace settings'}
          disabled={disabled}
        >
          {invalid ? (
            <WarningCircleIcon className="size-3.5" />
          ) : (
            <SlidersHorizontalIcon className="size-3.5" />
          )}
          {active && !invalid && (
            <span className="absolute right-1 top-1 size-1 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-64 max-w-[calc(100vw-2rem)] space-y-3 p-3"
        aria-label="Workspace settings"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <p className="text-xs font-medium">Workspace settings</p>
        {selection.provider === 'CODEX' && account && (
          <SettingRow label="Account">
            <CodexAccountPicker {...account} disabled={disabled} />
          </SettingRow>
        )}
        {accessMode && (
          <SettingRow label="Access">
            <AccessModeSelector control={accessMode} disabled={disabled} compact={false} />
          </SettingRow>
        )}
        {planMode && (
          <SettingRow label="Plan mode">
            <PlanningSelector
              control={planMode}
              disabled={disabled}
              disabledReason={disabledReason}
              showLabel
            />
          </SettingRow>
        )}
        <SettingRow label="PR updates">
          <RatchetToggleButton
            enabled={ratchetEnabled}
            state="IDLE"
            label={ratchetEnabled ? 'On' : 'Off'}
            onToggle={onRatchetChange}
            disabled={settingsLoading || disabled}
          />
        </SettingRow>
      </PopoverContent>
    </Popover>
  );
}

function getSettingsStatus(selection: SessionLaunchControlsProps, ratchetEnabled: boolean) {
  const { account, accessMode, planMode } = selection;
  const invalid = Boolean(accessMode?.invalid || (planMode?.enabled && !planMode.supported));
  const active = Boolean(account?.value || planMode?.enabled || ratchetEnabled);
  const accessLabel = accessMode?.options.find(
    (option) => option.value === accessMode.value
  )?.label;
  const summary = [
    accessLabel,
    planMode?.enabled && 'Plan on',
    ratchetEnabled && 'PR updates on',
    account?.value && account.accounts.find((entry) => entry.id === account.value)?.label,
  ]
    .filter(Boolean)
    .join(' · ');
  const description = invalid
    ? (selection.unavailableReason ?? 'Review workspace settings before launching')
    : summary;
  return { invalid, active, description };
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
