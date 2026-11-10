import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { StatusChip } from '@/client/components/status-indicators';
import { cn } from '@/lib/utils';

/** Pure presentation: inspecting a count never reads or acknowledges mail. */
export function UnreadMailBadge({
  count,
  icon = true,
  className,
}: {
  count?: number;
  icon?: boolean;
  className?: string;
}) {
  if (!count || count < 0) {
    return null;
  }
  const label = `${count} unread inbox ${count === 1 ? 'message' : 'messages'}`;
  return (
    <StatusChip
      tone="info"
      icon={icon && EnvelopeSimpleIcon}
      role="img"
      aria-label={label}
      title={label}
      className={cn('tabular-nums', className)}
    >
      {count > 99 ? '99+' : count}
    </StatusChip>
  );
}
