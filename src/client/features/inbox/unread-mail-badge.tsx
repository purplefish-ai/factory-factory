import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
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
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border border-info/20 bg-info/10 px-1 py-0.5 text-[10px] leading-none tabular-nums text-info',
        className
      )}
    >
      {icon && <EnvelopeSimpleIcon aria-hidden="true" className="size-3" />}
      {count > 99 ? '99+' : count}
    </span>
  );
}
