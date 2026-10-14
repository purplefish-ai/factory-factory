import { LightningIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { canResumePRMonitoring, PRDeliveryMode } from '@/shared/pr-monitoring';

export interface PRMonitoringMenuProps {
  enabled: boolean;
  deliveryMode: PRDeliveryMode;
  pending: boolean;
  pauseReason?: string | null;
  onResume?(): void;
  onToggle(enabled: boolean): void;
  onDeliveryMode(mode: PRDeliveryMode): void;
  onChangeRecipient(): void;
}
export function PRMonitoringMenuItems({
  enabled,
  deliveryMode,
  pending,
  pauseReason,
  onResume,
  onToggle,
  onDeliveryMode,
  onChangeRecipient,
}: PRMonitoringMenuProps) {
  return (
    <>
      <DropdownMenuItem disabled={pending} onSelect={() => onToggle(!enabled)}>
        {pending ? (
          <SpinnerGapIcon className="h-4 w-4 animate-spin" />
        ) : (
          <LightningIcon className="h-4 w-4" />
        )}
        {enabled ? 'Turn off PR updates' : 'Turn on PR updates'}
      </DropdownMenuItem>
      {enabled && canResumePRMonitoring(pauseReason) && onResume && (
        <DropdownMenuItem disabled={pending} onSelect={onResume}>
          Resume PR updates
        </DropdownMenuItem>
      )}
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        PR update destination
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={deliveryMode}
        onValueChange={(mode) => {
          if (mode === PRDeliveryMode.MAIN || mode === PRDeliveryMode.DEDICATED) {
            onDeliveryMode(mode);
          }
        }}
      >
        <DropdownMenuRadioItem value={PRDeliveryMode.MAIN} disabled={pending}>
          Main conversation
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value={PRDeliveryMode.DEDICATED} disabled={pending}>
          Dedicated conversation per PR
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <p className="px-2 pb-2 text-xs text-muted-foreground">
        {deliveryMode === PRDeliveryMode.DEDICATED
          ? 'Creates a conversation when an update arrives and reuses it for that PR.'
          : 'Queues updates in your selected conversation.'}
      </p>
      {enabled && deliveryMode === PRDeliveryMode.MAIN && (
        <DropdownMenuItem disabled={pending} onSelect={onChangeRecipient}>
          Change PR update conversation
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
}
