import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { cn } from '@/lib/utils';

/**
 * Inline pending indicator. It inherits the surrounding text color, so it
 * matches a button's label and reads as muted inside muted text. Pass
 * `aria-hidden` when nearby text already says what is pending.
 *
 * The default size is `h-4 w-4` rather than `size-4` on purpose: `Button` and
 * menu items size svgs without a `size-*` class, so the spinner inside them
 * follows the control's icon size. A `size-*` class still overrides it.
 */
function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <SpinnerGapIcon
      role="status"
      aria-label="Loading"
      data-slot="spinner"
      className={cn('h-4 w-4 shrink-0 animate-spin', className)}
      {...props}
      weight="regular"
    />
  );
}

export { Spinner };
