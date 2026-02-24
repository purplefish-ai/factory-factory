import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  type CiVisualState,
  deriveCiStatusFromCheckRollup,
  deriveCiVisualStateFromChecks,
  getCiVisualLabel,
} from '@/shared/ci-status';
import type { GitHubStatusCheck, ReviewDecision } from '@/shared/github-types';

export type CIStatus = CiVisualState;

export function getCIStatus(checks: GitHubStatusCheck[] | null): CIStatus {
  return deriveCiVisualStateFromChecks(checks);
}

function getSingleCheckCiStatus(check: GitHubStatusCheck) {
  return deriveCiStatusFromCheckRollup([check]);
}

function isSkippedOrCancelledCheck(check: GitHubStatusCheck): boolean {
  return check.conclusion === 'SKIPPED' || check.conclusion === 'CANCELLED';
}

function isPassedCheck(check: GitHubStatusCheck): boolean {
  return check.status === 'COMPLETED' && check.conclusion === 'SUCCESS';
}

interface CIStatusDotProps {
  checks: GitHubStatusCheck[] | null;
  size?: 'sm' | 'md';
}

export function CIStatusDot({ checks, size = 'sm' }: CIStatusDotProps) {
  const status = getCIStatus(checks);

  const sizeClasses = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';

  const dotStyles: Record<CIStatus, string> = {
    PASSING: 'bg-green-500',
    FAILING: 'bg-red-500',
    RUNNING: 'bg-yellow-500 animate-pulse',
    UNKNOWN: 'bg-gray-400',
    NONE: 'bg-gray-400',
  };

  const titles: Record<CIStatus, string> = {
    PASSING: 'CI passed',
    FAILING: 'CI failed',
    RUNNING: 'Checks running...',
    UNKNOWN: 'CI unknown',
    NONE: 'No checks',
  };

  return (
    <span
      className={`${sizeClasses} rounded-full inline-block flex-shrink-0 ${dotStyles[status]}`}
      title={titles[status]}
    />
  );
}

// Deduplicate checks by name, keeping the most relevant status
function deduplicateChecks(checks: GitHubStatusCheck[]): GitHubStatusCheck[] {
  const checkMap = new Map<string, GitHubStatusCheck>();

  const getPriority = (check: GitHubStatusCheck): number => {
    const ciStatus = getSingleCheckCiStatus(check);
    if (ciStatus === 'FAILURE') {
      return 4;
    }
    if (ciStatus === 'PENDING') {
      return 3;
    }
    if (ciStatus === 'SUCCESS') {
      return 2;
    }
    return 1;
  };

  for (const check of checks) {
    const existing = checkMap.get(check.name);
    if (!existing || getPriority(check) > getPriority(existing)) {
      checkMap.set(check.name, check);
    }
  }

  return Array.from(checkMap.values());
}

interface CIStatusBadgeProps {
  checks: GitHubStatusCheck[] | null;
}

export function CIStatusBadge({ checks }: CIStatusBadgeProps) {
  if (!checks || checks.length === 0) {
    return (
      <Badge variant="outline" className="text-xs">
        {getCiVisualLabel('NONE')}
      </Badge>
    );
  }

  const uniqueChecks = deduplicateChecks(checks);

  const failed = uniqueChecks.filter((c) => getSingleCheckCiStatus(c) === 'FAILURE').length;
  const pending = uniqueChecks.filter((c) => getSingleCheckCiStatus(c) === 'PENDING').length;
  const passed = uniqueChecks.filter((c) => isPassedCheck(c)).length;

  if (failed > 0) {
    return (
      <Badge variant="destructive" className="text-xs">
        {failed} failed
      </Badge>
    );
  }
  if (pending > 0) {
    return (
      <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600 text-xs">
        {pending} pending
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-green-500/20 text-green-600 text-xs">
      {passed} passed
    </Badge>
  );
}

interface ReviewDecisionBadgeProps {
  decision: ReviewDecision;
}

export function ReviewDecisionBadge({ decision }: ReviewDecisionBadgeProps) {
  switch (decision) {
    case 'APPROVED':
      return (
        <Badge className="bg-green-500/20 text-green-600 border-green-500/30 text-xs">
          Approved
        </Badge>
      );
    case 'CHANGES_REQUESTED':
      return (
        <Badge className="bg-red-500/20 text-red-600 border-red-500/30 text-xs">
          Changes requested
        </Badge>
      );
    case 'REVIEW_REQUIRED':
      return (
        <Badge className="bg-yellow-500/20 text-yellow-600 border-yellow-500/30 text-xs">
          Review required
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs">
          Pending
        </Badge>
      );
  }
}

interface CICheckItemProps {
  check: GitHubStatusCheck;
}

function CICheckItem({ check }: CICheckItemProps) {
  const ciStatus = getSingleCheckCiStatus(check);

  const getStatusIcon = () => {
    if (isSkippedOrCancelledCheck(check)) {
      return <span className="text-gray-400">○</span>;
    }
    if (ciStatus === 'SUCCESS') {
      return <span className="text-green-500">✓</span>;
    }
    if (ciStatus === 'FAILURE') {
      return <span className="text-red-500">✗</span>;
    }
    return <span className="text-yellow-500 animate-pulse">◐</span>;
  };

  const getStatusColor = () => {
    if (isSkippedOrCancelledCheck(check)) {
      return 'text-gray-500';
    }
    if (ciStatus === 'SUCCESS') {
      return 'text-green-600';
    }
    if (ciStatus === 'FAILURE') {
      return 'text-red-600';
    }
    return 'text-yellow-600';
  };

  const content = (
    <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 transition-colors group">
      <span className="w-4 flex-shrink-0">{getStatusIcon()}</span>
      <span className="flex-1 truncate text-sm" title={check.name}>
        {check.name}
      </span>
      <span className={`text-xs ${getStatusColor()}`}>{check.conclusion || check.status}</span>
      {check.detailsUrl && (
        <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100">→</span>
      )}
    </div>
  );

  if (check.detailsUrl) {
    return (
      <a href={check.detailsUrl} target="_blank" rel="noopener noreferrer" className="block">
        {content}
      </a>
    );
  }

  return content;
}

interface CIChecksSectionProps {
  checks: GitHubStatusCheck[] | null;
  defaultExpanded?: boolean;
}

export function CIChecksSection({ checks, defaultExpanded = true }: CIChecksSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!checks || checks.length === 0) {
    return null;
  }

  const uniqueChecks = deduplicateChecks(checks);

  const passed = uniqueChecks.filter((c) => isPassedCheck(c)).length;
  const failed = uniqueChecks.filter((c) => getSingleCheckCiStatus(c) === 'FAILURE').length;
  const pending = uniqueChecks.filter((c) => getSingleCheckCiStatus(c) === 'PENDING').length;
  const skipped = uniqueChecks.filter((c) => isSkippedOrCancelledCheck(c)).length;

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="text-xs text-muted-foreground font-medium">CI CHECKS</span>
        <span className="flex items-center gap-1.5 text-xs">
          {passed > 0 && <span className="text-green-600">{passed} passed</span>}
          {failed > 0 && <span className="text-red-600">{failed} failed</span>}
          {pending > 0 && <span className="text-yellow-600">{pending} pending</span>}
          {skipped > 0 && <span className="text-gray-500">{skipped} skipped</span>}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="px-1 pb-1">
          {uniqueChecks.map((check) => (
            <CICheckItem key={check.name} check={check} />
          ))}
        </div>
      )}
    </div>
  );
}
