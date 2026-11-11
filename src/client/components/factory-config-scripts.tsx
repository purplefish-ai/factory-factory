import { StatusCallout } from '@/client/components/status-callout';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';

interface FactoryConfigScriptsProps {
  factoryConfig: FactoryConfig;
  variant?: 'alert' | 'card';
}

export function FactoryConfigScripts({
  factoryConfig,
  variant = 'alert',
}: FactoryConfigScriptsProps) {
  const hasScripts =
    factoryConfig.scripts.setup ||
    factoryConfig.scripts.run ||
    factoryConfig.scripts.postRun ||
    factoryConfig.scripts.cleanup;

  if (!hasScripts) {
    return null;
  }

  if (variant === 'alert') {
    return (
      <StatusCallout tone="success" title="factory-factory.json detected">
        <div className="space-y-2">
          <p>
            This project has a factory-factory.json configuration file. New workspaces will
            automatically:
          </p>
          <ul className="space-y-1 ml-4">
            {factoryConfig.scripts.setup && (
              <li className="list-disc">
                Run setup script:{' '}
                <code className="bg-background px-1 rounded text-xs">
                  {factoryConfig.scripts.setup}
                </code>
              </li>
            )}
            {factoryConfig.scripts.run && (
              <li className="list-disc">
                Have a dev server available via the play button:{' '}
                <code className="bg-background px-1 rounded text-xs">
                  {factoryConfig.scripts.run}
                </code>
              </li>
            )}
            {factoryConfig.scripts.postRun && (
              <li className="list-disc">
                Run after dev server starts:{' '}
                <code className="bg-background px-1 rounded text-xs">
                  {factoryConfig.scripts.postRun}
                </code>
              </li>
            )}
            {factoryConfig.scripts.cleanup && (
              <li className="list-disc">
                Run cleanup on stop:{' '}
                <code className="bg-background px-1 rounded text-xs">
                  {factoryConfig.scripts.cleanup}
                </code>
              </li>
            )}
          </ul>
        </div>
      </StatusCallout>
    );
  }

  // Card variant for admin page
  return (
    <div className="space-y-4">
      {factoryConfig.scripts.setup && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Setup Script</p>
          <ScrollArea
            scrollbars="horizontal"
            viewportProps={{
              role: 'region',
              'aria-label': 'Setup script command',
              tabIndex: 0,
              className: 'whitespace-nowrap',
            }}
            className="max-w-full rounded bg-muted"
          >
            <code className="block px-3 py-2 font-mono text-xs">{factoryConfig.scripts.setup}</code>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">
            Runs automatically when a new workspace is created
          </p>
        </div>
      )}

      {factoryConfig.scripts.run && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Run Script</p>
          <ScrollArea
            scrollbars="horizontal"
            viewportProps={{
              role: 'region',
              'aria-label': 'Run script command',
              tabIndex: 0,
              className: 'whitespace-nowrap',
            }}
            className="max-w-full rounded bg-muted"
          >
            <code className="block px-3 py-2 font-mono text-xs">{factoryConfig.scripts.run}</code>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">
            Available via the play button in each workspace
          </p>
        </div>
      )}

      {factoryConfig.scripts.postRun && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Post-Run Script</p>
          <ScrollArea
            scrollbars="horizontal"
            viewportProps={{
              role: 'region',
              'aria-label': 'Post-run script command',
              tabIndex: 0,
              className: 'whitespace-nowrap',
            }}
            className="max-w-full rounded bg-muted"
          >
            <code className="block px-3 py-2 font-mono text-xs">
              {factoryConfig.scripts.postRun}
            </code>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">
            Runs automatically after the dev server starts
          </p>
        </div>
      )}

      {factoryConfig.scripts.cleanup && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Cleanup Script</p>
          <ScrollArea
            scrollbars="horizontal"
            viewportProps={{
              role: 'region',
              'aria-label': 'Cleanup script command',
              tabIndex: 0,
              className: 'whitespace-nowrap',
            }}
            className="max-w-full rounded bg-muted"
          >
            <code className="block px-3 py-2 font-mono text-xs">
              {factoryConfig.scripts.cleanup}
            </code>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">Runs when stopping the dev server</p>
        </div>
      )}
    </div>
  );
}
