import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Shared trigger for settings in chat and new-conversation composers. */
export function ComposerMenuTrigger({
  children,
  className,
  indicator,
  ...props
}: ComponentProps<typeof Button> & { indicator?: ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'h-6 min-w-0 max-w-[14rem] gap-1 px-2 text-xs text-muted-foreground hover:text-foreground',
        className
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      {indicator ?? <CaretDownIcon className="size-3 shrink-0" />}
    </Button>
  );
}
