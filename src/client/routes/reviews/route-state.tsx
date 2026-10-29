import { Button } from '@/components/ui/button';

export function ReviewRouteState({
  message,
  error,
  onRetry,
}: {
  message?: string;
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="space-y-3 text-center" role={error ? 'alert' : 'status'}>
        <h1 className="text-sm font-semibold">Reviews</h1>
        <p className="text-sm text-muted-foreground">{error ?? message}</p>
        {error && onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
      </div>
    </div>
  );
}
