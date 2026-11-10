import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleDashedIcon } from '@phosphor-icons/react/dist/csr/CircleDashed';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { useCLIHealthRefresh } from '@/client/hooks/use-cli-health-refresh';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface OnboardingCliHealthProps {
  onOpenTerminal: () => void;
}

type ItemStatus = 'ok' | 'warning' | 'missing';

interface StatusItem {
  label: string;
  status: ItemStatus;
  detail: string;
}

function StatusIcon({ status }: { status: ItemStatus }) {
  if (status === 'ok') {
    return <CheckCircleIcon className="h-4 w-4 text-success" />;
  }
  if (status === 'warning') {
    return <WarningIcon className="h-4 w-4 text-warning" />;
  }
  return <CircleDashedIcon className="h-4 w-4 text-muted-foreground" />;
}

function buildItems(health: {
  claude: { isInstalled: boolean; isAuthenticated?: boolean };
  codex: { isInstalled: boolean; isAuthenticated?: boolean; error?: string };
  github: { isInstalled: boolean; isAuthenticated: boolean };
}): StatusItem[] {
  const items: StatusItem[] = [];

  // Claude
  if (!health.claude.isInstalled) {
    items.push({
      label: 'Claude',
      status: 'missing',
      detail: 'Bundled runtime unavailable — update Factory Factory',
    });
  } else if (health.claude.isAuthenticated !== true) {
    items.push({
      label: 'Claude',
      status: 'warning',
      detail: 'Installed — use Sign in to Claude in the setup terminal',
    });
  } else {
    items.push({ label: 'Claude', status: 'ok', detail: 'Ready' });
  }

  // Codex
  if (!health.codex.isInstalled) {
    items.push({
      label: 'Codex',
      status: 'missing',
      detail: health.codex.error ?? 'Bundled runtime unavailable — update Factory Factory',
    });
  } else if (health.codex.isAuthenticated !== true) {
    items.push({
      label: 'Codex',
      status: 'warning',
      detail: 'Use Sign in to Codex in the setup terminal',
    });
  } else {
    items.push({ label: 'Codex', status: 'ok', detail: 'Ready' });
  }

  // GitHub
  if (!health.github.isInstalled) {
    items.push({ label: 'GitHub CLI', status: 'missing', detail: 'Not installed' });
  } else if (!health.github.isAuthenticated) {
    items.push({
      label: 'GitHub CLI',
      status: 'warning',
      detail: 'Installed — run gh auth login to authenticate',
    });
  } else {
    items.push({ label: 'GitHub CLI', status: 'ok', detail: 'Ready' });
  }

  return items;
}

export function OnboardingCliHealth({ onOpenTerminal }: OnboardingCliHealthProps) {
  const { refresh, isRefreshing } = useCLIHealthRefresh();
  const {
    data: health,
    error,
    isRefetching,
  } = trpc.admin.checkCLIHealth.useQuery({ forceRefresh: false }, { staleTime: 60_000 });

  if (!health) {
    return error ? (
      <QueryErrorState
        title="Couldn't check CLI prerequisites"
        error={error}
        onRetry={() => void refresh()}
        isRetrying={isRefreshing}
        className="p-3"
      />
    ) : (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Spinner className="h-4 w-4" />
        <span>Checking CLI prerequisites…</span>
      </div>
    );
  }

  const items = buildItems(health);
  const hasIssues = items.some((item) => item.status !== 'ok');

  return (
    <div className="space-y-3">
      {error ? (
        <QueryRefreshError
          title="Couldn't refresh CLI prerequisites"
          error={error}
          onRetry={() => void refresh()}
          isRetrying={isRefreshing || isRefetching}
          className="rounded-md border"
        />
      ) : null}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">CLI Prerequisites</p>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          className="text-muted-foreground"
          onClick={() => void refresh()}
          pending={isRefetching || isRefreshing}
        >
          <ArrowsClockwiseIcon />
          Recheck
        </Button>
      </div>

      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2 text-sm">
            <StatusIcon status={item.status} />
            <span className="font-medium">{item.label}</span>
            <span className="text-muted-foreground">— {item.detail}</span>
          </li>
        ))}
      </ul>

      {hasIssues && (
        <Button type="button" variant="outline" size="sm" onClick={onOpenTerminal}>
          <TerminalIcon />
          Open terminal to log in
        </Button>
      )}
    </div>
  );
}
