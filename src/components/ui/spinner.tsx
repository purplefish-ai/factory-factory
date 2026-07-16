import { SpinnerGapIcon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <SpinnerGapIcon
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin text-brand', className)}
      {...props}
    />
  );
}

export { Spinner };
