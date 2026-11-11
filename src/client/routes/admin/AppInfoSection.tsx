import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { trpc } from '@/client/lib/trpc';
import { Label } from '@/components/ui/label';
import { SettingsSection } from './settings-section';

function formatPortLabel(
  port: number | null | undefined,
  missingLabel = '(restart to detect)'
): string {
  return port != null ? String(port) : missingLabel;
}

function getFrontendPortLabel(location: Location): string {
  if (location.port) {
    const parsedPort = Number.parseInt(location.port, 10);
    if (!Number.isNaN(parsedPort)) {
      return String(parsedPort);
    }
  }

  if (location.protocol === 'http:') {
    return '80';
  }

  if (location.protocol === 'https:') {
    return '443';
  }

  return '(not available)';
}

export function AppInfoSection() {
  const serverInfoQuery = trpc.admin.getServerInfo.useQuery();
  const frontendPort = getFrontendPortLabel(window.location);

  return (
    <SettingsSection
      title="App info"
      description="Repository and runtime details"
      query={serverInfoQuery}
      errorTitle="Couldn't load app info"
    >
      {(serverInfo) => (
        <>
          <div className="space-y-2">
            <Label>Repository</Label>
            <a
              href="https://github.com/purplefish-ai/factory-factory"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              GitHub
              <ArrowSquareOutIcon className="h-3.5 w-3.5" />
            </a>
          </div>
          <div className="space-y-2">
            <Label>Ports</Label>
            <div className="space-y-1 text-sm text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Frontend</span>
                <code className="rounded bg-muted px-1.5 py-0.5">{frontendPort}</code>
              </div>
              <div className="flex items-center justify-between">
                <span>Backend</span>
                <code className="rounded bg-muted px-1.5 py-0.5">
                  {formatPortLabel(serverInfo.backendPort)}
                </code>
              </div>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
