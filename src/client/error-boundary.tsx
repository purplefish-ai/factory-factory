import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Component, type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ErrorBoundaryVariant = 'page' | 'compact';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Replaces the built-in fallback entirely. */
  fallback?: ReactNode;
  /** `page` centers a card in its container; `compact` fits inside a panel. */
  variant?: ErrorBoundaryVariant;
  /** Fallback title, e.g. "Couldn't show the viewer". */
  title?: string;
  /** Offer "Try again", which re-renders the children. Use it only where a retry can succeed. */
  showRetry?: boolean;
  /** Changing this value after a crash resets the boundary, e.g. the current pathname. */
  resetKey?: unknown;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/** React can catch any thrown value, including null and undefined. */
export function normalizeThrownError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === 'string' ? error : 'An unexpected error occurred.', {
    cause: error,
  });
}

/** Report a caught render error with its component trace, without console methods. */
export function reportBoundaryError(error: Error, errorInfo: React.ErrorInfo) {
  const componentStack = errorInfo.componentStack ?? '';
  const stackWithComponentTrace =
    componentStack.trim().length > 0
      ? `${error.stack ?? error.message}\n${componentStack}`
      : (error.stack ?? error.message);

  const loggedError = new Error(error.message, { cause: error });
  loggedError.stack = stackWithComponentTrace;
  globalThis.reportError?.(loggedError);
}

/** Plain-text report for "Copy details": message, location, stack and component trace. */
export function formatErrorDetails(
  error: Error,
  componentStack: string | null,
  context: { url: string; userAgent: string; time: Date }
): string {
  const lines = [
    `${error.name}: ${error.message}`,
    '',
    `URL: ${context.url}`,
    `Time: ${context.time.toISOString()}`,
    `User agent: ${context.userAgent}`,
  ];
  if (error.stack) {
    lines.push('', 'Stack:', error.stack);
  }
  const trimmedComponentStack = componentStack?.trim();
  if (trimmedComponentStack) {
    lines.push('', 'Component stack:', trimmedComponentStack);
  }
  return lines.join('\n');
}

const DEFAULT_TITLES: Record<ErrorBoundaryVariant, string> = {
  page: "Couldn't show this page",
  compact: "Couldn't show this panel",
};

const COPY_FEEDBACK_MS = 2000;

type CopyStatus = 'idle' | 'copied' | 'failed';

function CopyDetailsButton({ details, size }: { details: string; size: 'sm' | 'default' }) {
  const [status, setStatus] = useState<CopyStatus>('idle');

  useEffect(() => {
    if (status === 'idle') {
      return;
    }
    const timer = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  const labels: Record<CopyStatus, string> = {
    idle: 'Copy details',
    copied: 'Copied',
    failed: "Couldn't copy",
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={() => {
        void handleCopy();
      }}
    >
      {status === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span aria-live="polite">{labels[status]}</span>
    </Button>
  );
}

export interface ErrorFallbackProps {
  error: Error;
  componentStack?: string | null;
  variant?: ErrorBoundaryVariant;
  title?: string;
  /** Shows "Try again" when provided. */
  onReset?: () => void;
  /** Defaults to reloading the window. */
  onReload?: () => void;
  className?: string;
}

/** The built-in boundary fallback, exported for stories and tests. */
export function ErrorFallback({
  error,
  componentStack = null,
  variant = 'page',
  title = DEFAULT_TITLES[variant],
  onReset,
  onReload = () => window.location.reload(),
  className,
}: ErrorFallbackProps) {
  const details = formatErrorDetails(error, componentStack, {
    url: window.location.href,
    userAgent: navigator.userAgent,
    time: new Date(),
  });
  const message = error.message.trim();

  if (variant === 'compact') {
    return (
      <div
        role="alert"
        className={cn(
          'flex h-full flex-col items-center justify-center gap-2 p-4 text-center',
          className
        )}
      >
        <WarningCircleIcon className="size-6 text-destructive" aria-hidden="true" />
        <div className="max-w-sm space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {message ? (
            <p className="line-clamp-3 break-words text-xs text-muted-foreground">{message}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-1">
          {onReset ? (
            <Button type="button" variant="outline" size="sm" onClick={onReset}>
              Try again
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            <ArrowClockwiseIcon aria-hidden="true" />
            Reload
          </Button>
          <CopyDetailsButton details={details} size="sm" />
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex h-full w-full items-center justify-center bg-background p-4 sm:p-6',
        className
      )}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <WarningCircleIcon className="mx-auto mb-3 size-8 text-destructive" aria-hidden="true" />
        <h2 className="mb-1 text-lg font-semibold text-foreground">{title}</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Something unexpected went wrong. Reload to start fresh, or copy the details to report it.
        </p>
        {message ? (
          <pre className="mb-4 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-left text-xs text-muted-foreground">
            {message}
          </pre>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={onReload}>
            <ArrowClockwiseIcon aria-hidden="true" />
            Reload
          </Button>
          {onReset ? (
            <Button type="button" variant="outline" onClick={onReset}>
              Try again
            </Button>
          ) : null}
          <CopyDetailsButton details={details} size="default" />
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: normalizeThrownError(error) };
  }

  override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    reportBoundaryError(this.state.error ?? normalizeThrownError(error), errorInfo);
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState) {
    if (
      prevState.error &&
      this.state.error &&
      !Object.is(prevProps.resetKey, this.props.resetKey)
    ) {
      this.handleReset();
    }
  }

  handleReset = () => {
    this.setState({ error: null, componentStack: null });
  };

  override render() {
    const { error, componentStack } = this.state;
    if (!error) {
      return this.props.children;
    }
    if (this.props.fallback) {
      return this.props.fallback;
    }
    return (
      <ErrorFallback
        error={error}
        componentStack={componentStack}
        variant={this.props.variant}
        title={this.props.title}
        onReset={this.props.showRetry ? this.handleReset : undefined}
        className={this.props.className}
      />
    );
  }
}
