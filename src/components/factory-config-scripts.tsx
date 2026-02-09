import { CheckCircle2, FileJson } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
    factoryConfig.scripts.setup || factoryConfig.scripts.run || factoryConfig.scripts.cleanup;

  if (!hasScripts) {
    return null;
  }

  if (variant === 'alert') {
    return (
      <Alert className="bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
        <FileJson className="h-4 w-4 text-green-600 dark:text-green-400" />
        <AlertDescription>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
              <span className="font-medium text-green-900 dark:text-green-100">
                factory-factory.json detected
              </span>
            </div>
            <p className="text-sm text-green-800 dark:text-green-200">
              This project has a factory-factory.json configuration file. New workspaces will
              automatically:
            </p>
            <ul className="text-sm text-green-800 dark:text-green-200 space-y-1 ml-4">
              {factoryConfig.scripts.setup && (
                <li className="list-disc">
                  Run setup script:{' '}
                  <code className="bg-green-100 dark:bg-green-900 px-1 rounded text-xs">
                    {factoryConfig.scripts.setup}
                  </code>
                </li>
              )}
              {factoryConfig.scripts.run && (
                <li className="list-disc">
                  Have a dev server available via the play button:{' '}
                  <code className="bg-green-100 dark:bg-green-900 px-1 rounded text-xs">
                    {factoryConfig.scripts.run}
                  </code>
                </li>
              )}
              {factoryConfig.scripts.cleanup && (
                <li className="list-disc">
                  Run cleanup on stop:{' '}
                  <code className="bg-green-100 dark:bg-green-900 px-1 rounded text-xs">
                    {factoryConfig.scripts.cleanup}
                  </code>
                </li>
              )}
            </ul>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  // Card variant for admin page
  return (
    <div className="rounded-md border bg-muted/50 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5" />
        <div className="space-y-1 flex-1">
          <p className="font-medium text-sm">Configuration Found</p>
          <p className="text-xs text-muted-foreground">
            factory-factory.json is configured in this repository
          </p>
        </div>
      </div>

      <div className="space-y-2 pl-8">
        {factoryConfig.scripts.setup && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Setup Script</p>
            <code className="block bg-background px-3 py-2 rounded text-xs font-mono">
              {factoryConfig.scripts.setup}
            </code>
            <p className="text-xs text-muted-foreground">
              Runs automatically when a new workspace is created
            </p>
          </div>
        )}

        {factoryConfig.scripts.run && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Run Script</p>
            <code className="block bg-background px-3 py-2 rounded text-xs font-mono">
              {factoryConfig.scripts.run}
            </code>
            <p className="text-xs text-muted-foreground">
              Available via the play button in each workspace
            </p>
          </div>
        )}

        {factoryConfig.scripts.cleanup && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Cleanup Script</p>
            <code className="block bg-background px-3 py-2 rounded text-xs font-mono">
              {factoryConfig.scripts.cleanup}
            </code>
            <p className="text-xs text-muted-foreground">Runs when stopping the dev server</p>
          </div>
        )}
      </div>
    </div>
  );
}
