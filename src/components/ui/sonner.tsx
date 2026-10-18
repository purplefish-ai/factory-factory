import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <XCircleIcon className="size-4" />,
        loading: <SpinnerGapIcon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
