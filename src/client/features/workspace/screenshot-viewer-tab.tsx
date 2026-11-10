import { QueryState } from '@/client/components/query-state';
import { trpc } from '@/client/lib/trpc';

interface ScreenshotViewerTabProps {
  workspaceId: string;
  screenshotPath: string;
  tabId: string;
}

export function ScreenshotViewerTab({ workspaceId, screenshotPath }: ScreenshotViewerTabProps) {
  const screenshot = trpc.workspace.readScreenshot.useQuery(
    { workspaceId, path: screenshotPath },
    { staleTime: 60_000 }
  );

  return (
    <div className="flex h-full flex-col">
      <QueryState
        query={screenshot}
        errorTitle="Couldn't load screenshot"
        loadingMessage="Loading screenshot…"
        className="h-full"
      >
        {(data) => (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
            <img
              src={`data:${data.mimeType};base64,${data.data}`}
              alt={data.name}
              className="max-w-full max-h-full object-contain rounded-md"
            />
          </div>
        )}
      </QueryState>
    </div>
  );
}
