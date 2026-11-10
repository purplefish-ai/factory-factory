import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /**
     * The action this button started is in flight. The button is disabled and
     * `aria-busy`, and a `Spinner` replaces its icon: icon-size buttons hide
     * every direct child except screen-reader text; other sizes hide their
     * direct svg icons and keep the label beside the spinner. With `asChild`
     * only the disabled and busy state apply.
     */
    pending?: boolean;
    /**
     * Label while `pending` ("Saving…"). It replaces the children of text
     * buttons and becomes the accessible name of icon-size buttons.
     */
    pendingLabel?: string;
  };

function isIconSize(size: ButtonProps['size']): boolean {
  return size === 'icon' || size === 'icon-xs' || size === 'icon-sm' || size === 'icon-lg';
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  pending = false,
  pendingLabel,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const iconOnly = isIconSize(size);
  const showSpinner = pending && !asChild;

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        buttonVariants({ variant, size }),
        showSpinner &&
          (iconOnly
            ? "[&>:not([data-slot='spinner'],.sr-only)]:hidden"
            : "[&>svg:not([data-slot='spinner'])]:hidden"),
        className
      )}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      {...props}
      {...(pending && iconOnly && pendingLabel ? { 'aria-label': pendingLabel } : {})}
    >
      {showSpinner ? (
        <>
          <Spinner aria-hidden="true" />
          {iconOnly ? children : (pendingLabel ?? children)}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
