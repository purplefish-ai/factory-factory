import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { Link } from 'react-router';
import { trpc } from '@/client/lib/trpc';
import type { ChatModelOption, ChatProvider } from '@/shared/chat-capabilities';

interface MissingModel {
  provider: ChatProvider;
  model: string;
}

/** Mirror the runtime's Claude alias rules using the catalog's formatted labels. */
function hasClaudeModelAlias(model: string, options: ChatModelOption[]) {
  const alias = /^(sonnet|opus|haiku|fable)(\[1m\])?$/.exec(model);
  if (alias) {
    const matches = options.filter(
      (option) =>
        option.value.startsWith(`claude-${alias[1]}-`) &&
        option.value.endsWith('[1m]') === model.endsWith('[1m]')
    );
    return matches.length === 1;
  }
  const canonical = /^claude-(sonnet|opus|haiku|fable)-(\d+(?:-\d+)*)(\[1m\])?$/.exec(model);
  if (!canonical) {
    return false;
  }
  const [, family, version, context = ''] = canonical;
  return options.some(
    (option) =>
      option.value === `${family}${context}` &&
      option.label.toLowerCase().replace(/\s+\([^)]*\)$/, '') ===
        `${family} ${version?.replaceAll('-', '.')}`
  );
}

function isMissingModel(
  provider: ChatProvider,
  model: string,
  catalog: { source: 'cli' | 'fallback'; models: ChatModelOption[] }
) {
  if (catalog.source !== 'cli' || !model) {
    return false;
  }
  if (provider === 'CODEX' && model === 'default') {
    return false;
  }
  if (provider === 'CLAUDE' && hasClaudeModelAlias(model, catalog.models)) {
    return false;
  }
  return !catalog.models.some((option) => option.value === model);
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
  });
  if (!(settings && catalog)) {
    return null;
  }
  const models: MissingModel[] = [
    { provider: 'CLAUDE', model: settings.defaultClaudeModel },
    { provider: 'CODEX', model: settings.defaultCodexModel },
  ];
  return (
    <ModelCatalogWarningContent
      models={models.filter(({ provider, model }) =>
        isMissingModel(provider, model, catalog[provider])
      )}
    />
  );
}
