import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Small uppercase heading for a group of rows, a menu group or a panel region.
 * Pass `asChild` to apply the style to a heading or `SelectLabel`, keeping its
 * semantics: `<SectionLabel asChild><h3>Changes</h3></SectionLabel>`.
 */
export function SectionLabel({
  asChild = false,
  className,
  ...props
}: ComponentProps<'span'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      data-slot="section-label"
      className={cn(
        'text-2xs font-medium uppercase tracking-wider text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}
