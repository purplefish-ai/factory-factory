import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Shared trigger for settings in chat and new-conversation composers. */
export function ComposerMenuTrigger({
  children,
  className,
  indicator,
  icon,
  iconOnly = false,
  ...props
}: ComponentProps<typeof Button> & {
  indicator?: ReactNode;
  icon?: ReactNode;
  iconOnly?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size={iconOnly ? 'icon-xs' : 'xs'}
      className={cn('min-w-0 max-w-[14rem] text-muted-foreground hover:text-foreground', className)}
      {...props}
    >
      {icon}
      {!iconOnly && (
        <>
          <span className="truncate">{children}</span>
          {indicator ?? <CaretDownIcon className="shrink-0" />}
        </>
      )}
    </Button>
  );
}
