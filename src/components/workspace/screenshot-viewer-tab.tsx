import { Loader2 } from 'lucide-react';

import { trpc } from '@/client/lib/trpc';

interface ScreenshotViewerTabProps {
  workspaceId: string;
  screenshotPath: string;
  tabId: string;
}

export function ScreenshotViewerTab({ workspaceId, screenshotPath }: ScreenshotViewerTabProps) {
  const { data, isLoading } = trpc.workspace.readScreenshot.useQuery(
    { workspaceId, path: screenshotPath },
    { staleTime: 60_000 }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Failed to load screenshot
      </div>
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
