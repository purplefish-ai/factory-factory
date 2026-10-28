import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { Link } from 'react-router';
import { trpc } from '@/client/lib/trpc';
import { resolveClaudeModelAlias } from '@/shared/acp-protocol/model-selection';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';

interface MissingModel {
  provider: ChatProvider;
  model: string;
}

interface ModelDefaults {
  defaultClaudeModel: string;
  defaultCodexModel: string;
}

type ModelCatalog = Record<ChatProvider, { source: 'cli' | 'fallback'; models: ChatModelOption[] }>;

function isMissingModel(
  provider: ChatProvider,
  model: string,
  catalog: ModelCatalog[ChatProvider]
) {
  if (catalog.source !== 'cli' || !model) {
    return false;
  }
  if (provider === 'CODEX' && model === 'default') {
    return false;
  }
  if (provider === 'CLAUDE' && resolveClaudeModelAlias(model, catalog.models)) {
    return false;
  }
  return !catalog.models.some((option) => option.value === model);
}

function getMissingModels(settings: ModelDefaults | undefined, catalog: ModelCatalog | undefined) {
  if (!(settings && catalog)) {
    return [];
  }
  const models: MissingModel[] = [
    { provider: 'CLAUDE', model: settings.defaultClaudeModel },
    { provider: 'CODEX', model: settings.defaultCodexModel },
  ];
  return models.filter(({ provider, model }) => isMissingModel(provider, model, catalog[provider]));
}

export function ModelCatalogWarningContent({ models }: { models: MissingModel[] }) {
  if (models.length === 0) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs sm:px-4"
    >
      <WarningIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0 space-y-1">
        {models.map(({ provider, model }) => (
          <p key={provider} className="text-amber-800 [overflow-wrap:anywhere] dark:text-amber-300">
            Your default {provider === 'CLAUDE' ? 'Claude' : 'Codex'} model{' '}
            <span className="font-medium">{model}</span> is not in the current model catalog.
          </p>
        ))}
        <p className="text-muted-foreground">
          New conversations may fail to start.{' '}
          <Link to="/admin" className="font-medium text-foreground underline underline-offset-2">
            Review chat defaults
          </Link>
        </p>
      </div>
    </div>
  );
}

/** Surface stale defaults across the app without changing the user's saved selection. */
export function ModelCatalogWarning() {
  const { data: settings } = trpc.userSettings.get.useQuery();
  const { data: catalog } = trpc.userSettings.getProviderOptions.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    // Live discovery starts provider processes; poll only while there is a warning to resolve.
    refetchInterval: (query) =>
      getMissingModels(settings, query.state.data).length > 0 ? 60_000 : false,
  });
  return <ModelCatalogWarningContent models={getMissingModels(settings, catalog)} />;
}
