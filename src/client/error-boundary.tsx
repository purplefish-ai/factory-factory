import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(_error: Error, _errorInfo: React.ErrorInfo) {
    // Error state is handled by getDerivedStateFromError.
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-lg">
            <h2 className="mb-2 text-xl font-semibold text-foreground">Something went wrong</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              An unexpected error occurred. Please try again.
            </p>
            {this.state.error && (
              <pre className="mb-4 max-h-32 overflow-auto rounded bg-muted p-2 text-left text-xs text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
