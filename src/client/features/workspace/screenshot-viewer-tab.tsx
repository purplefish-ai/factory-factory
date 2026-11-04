import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { trpc } from '@/client/lib/trpc';

interface ScreenshotViewerTabProps {
  workspaceId: string;
  screenshotPath: string;
  tabId: string;
}

export function ScreenshotViewerTab({ workspaceId, screenshotPath }: ScreenshotViewerTabProps) {
  const { data, isLoading, error, isFetching, refetch } = trpc.workspace.readScreenshot.useQuery(
    { workspaceId, path: screenshotPath },
    { staleTime: 60_000 }
  );

  if (isLoading) {
    return <Loading message="Loading screenshot…" />;
  }

  if (!data) {
    return (
      <QueryErrorState
        title="Couldn't load screenshot"
        error={error}
        onRetry={() => {
          void refetch();
        }}
        isRetrying={isFetching}
        className="h-full"
      />
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4 overflow-auto">
      <img
        src={`data:${data.mimeType};base64,${data.data}`}
        alt={data.name}
        className="max-w-full max-h-full object-contain rounded-md"
      />
    </div>
  );
}
