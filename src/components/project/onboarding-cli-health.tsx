import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  RefreshCwIcon,
  TerminalIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/frontend/lib/trpc';

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
    return <CheckCircle2Icon className="h-4 w-4 text-green-600 dark:text-green-400" />;
  }
  if (status === 'warning') {
    return <AlertTriangleIcon className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />;
  }
  return <CircleDashedIcon className="h-4 w-4 text-muted-foreground" />;
}

function buildItems(health: {
  claude: { isInstalled: boolean };
  codex: { isInstalled: boolean; isAuthenticated?: boolean };
  github: { isInstalled: boolean; isAuthenticated: boolean };
}): StatusItem[] {
  const items: StatusItem[] = [];

  // Claude
  if (!health.claude.isInstalled) {
    items.push({ label: 'Claude', status: 'missing', detail: 'Not installed' });
  } else {
    items.push({
      label: 'Claude',
      status: 'warning',
      detail: 'Installed — run claude login to authenticate',
    });
  }

  // Codex
  if (!health.codex.isInstalled) {
    items.push({ label: 'Codex', status: 'missing', detail: 'Not installed (optional)' });
  } else if (health.codex.isAuthenticated === false) {
    items.push({
      label: 'Codex',
      status: 'warning',
      detail: 'Installed — run codex login to authenticate',
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
  const {
    data: health,
    isLoading,
    refetch,
    isRefetching,
  } = trpc.admin.checkCLIHealth.useQuery(
    { forceRefresh: false },
    { refetchOnWindowFocus: false, staleTime: 60_000 }
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Spinner className="h-4 w-4" />
        <span>Checking CLI prerequisites...</span>
      </div>
    );
  }

  if (!health) {
    return null;
  }

  const items = buildItems(health);
  const hasIssues = items.some((item) => item.status !== 'ok');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">CLI Prerequisites</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCwIcon className={`mr-1 h-3 w-3 ${isRefetching ? 'animate-spin' : ''}`} />
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
          <TerminalIcon className="mr-2 h-4 w-4" />
          Open Terminal to Log In
        </Button>
      )}
    </div>
  );
}
