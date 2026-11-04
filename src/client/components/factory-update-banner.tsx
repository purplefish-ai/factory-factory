import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

const DISMISSED_RELEASE_KEY = 'ff_dismissed_factory_release';

function readDismissedRelease(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_RELEASE_KEY);
  } catch {
    return null;
  }
}

export function FactoryUpdateBannerContent({
  currentVersion,
  latestVersion,
  onDismiss,
}: {
  currentVersion: string;
  latestVersion: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs sm:px-4"
    >
      <p className="min-w-0 flex-1 basis-full [overflow-wrap:anywhere] sm:basis-0">
        <span className="font-medium">Factory Factory {latestVersion} is available.</span>{' '}
        <span className="text-muted-foreground">You’re running {currentVersion}.</span>
      </p>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <a
            href="https://github.com/purplefish-ai/factory-factory#updating"
            target="_blank"
            rel="noopener noreferrer"
          >
            View upgrade instructions
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss update notification"
          onClick={onDismiss}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function FactoryUpdateBanner() {
  const [dismissedVersion, setDismissedVersion] = useState(readDismissedRelease);
  const { data } = trpc.admin.checkFactoryUpdate.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  if (!(data?.updateAvailable && data.latestVersion) || data.latestVersion === dismissedVersion) {
    return null;
  }
  const latestVersion = data.latestVersion;
  const dismiss = () => {
    setDismissedVersion(latestVersion);
    try {
      window.localStorage.setItem(DISMISSED_RELEASE_KEY, latestVersion);
    } catch {
      // Dismissal still works for this session when storage is blocked.
    }
  };
  return (
    <FactoryUpdateBannerContent
      currentVersion={data.currentVersion}
      latestVersion={latestVersion}
      onDismiss={dismiss}
    />
  );
}
