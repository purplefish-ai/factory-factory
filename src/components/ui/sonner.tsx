import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { useTheme } from 'next-themes';
import { type ExternalToast, Toaster as Sonner, type ToasterProps, toast } from 'sonner';

/**
 * Error toasts stay up longer than sonner's 4 s default and get a close button,
 * so there is time to read the failure. Other toast types keep sonner's
 * defaults. Explicit `duration`/`closeButton` options on a call still win.
 */
export const ERROR_TOAST_DURATION_MS = 10_000;

export function withErrorToastDefaults(data?: ExternalToast): ExternalToast {
  return {
    ...data,
    duration: data?.duration ?? ERROR_TOAST_DURATION_MS,
    closeButton: data?.closeButton ?? true,
  };
}

type ErrorToastApi = Pick<typeof toast, 'error'>;
const patchedToastApis = new WeakSet<ErrorToastApi>();

/**
 * Sonner has no per-type duration option, so wrap `toast.error` once. Every
 * `import { toast } from 'sonner'` call site shares this singleton and picks up
 * the defaults without being rewritten.
 */
export function installErrorToastDefaults(api: ErrorToastApi = toast): void {
  if (patchedToastApis.has(api)) {
    return;
  }
  patchedToastApis.add(api);
  const showError = api.error;
  api.error = (message, data) => showError(message, withErrorToastDefaults(data));
}

installErrorToastDefaults();

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
      // Sonner's description color is fixed per sonner theme; use the app token
      // so the server detail stays readable on the popover background.
      toastOptions={{ classNames: { description: 'text-muted-foreground!' } }}
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
