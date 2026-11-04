import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { cn } from '@/lib/utils';

/**
 * Inline pending indicator. It inherits the surrounding text color, so it
 * matches a button's label and reads as muted inside muted text. Pass
 * `aria-hidden` when nearby text already says what is pending.
 */
function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <SpinnerGapIcon
      role="status"
      aria-label="Loading"
      className={cn('size-4 shrink-0 animate-spin', className)}
      {...props}
      weight="regular"
    />
  );
}

export { Spinner };
