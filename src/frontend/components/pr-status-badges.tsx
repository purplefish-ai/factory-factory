'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { GitHubStatusCheck, ReviewDecision } from '@/shared/github-types';

export type CIStatus = 'pass' | 'fail' | 'pending' | 'none';

export function getCIStatus(
  checks: { conclusion: string | null; status: string }[] | null
): CIStatus {
  if (!checks || checks.length === 0) {
    return 'none';
  }

  const failed = checks.some((c) => c.conclusion === 'FAILURE');
  if (failed) {
    return 'fail';
  }

  const pending = checks.some((c) => c.status !== 'COMPLETED' || c.conclusion === null);
  if (pending) {
    return 'pending';
  }

  return 'pass';
}

interface CIStatusDotProps {
  checks: { conclusion: string | null; status: string }[] | null;
  size?: 'sm' | 'md';
}

export function CIStatusDot({ checks, size = 'sm' }: CIStatusDotProps) {
  const status = getCIStatus(checks);

  const sizeClasses = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';

  const dotStyles: Record<CIStatus, string> = {
    pass: 'bg-green-500',
    fail: 'bg-red-500',
    pending: 'bg-yellow-500 animate-pulse',
    none: 'bg-gray-400',
  };

  const titles: Record<CIStatus, string> = {
    pass: 'CI passed',
    fail: 'CI failed',
    pending: 'Checks running...',
    none: 'No checks',
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
    if (check.conclusion === 'FAILURE') {
      return 4;
    }
    if (check.status !== 'COMPLETED' || check.conclusion === null) {
      return 3;
    }
    if (check.conclusion === 'SUCCESS') {
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
        No checks
      </Badge>
    );
  }

  const uniqueChecks = deduplicateChecks(checks);

  const failed = uniqueChecks.filter((c) => c.conclusion === 'FAILURE').length;
  const pending = uniqueChecks.filter(
    (c) => c.status !== 'COMPLETED' || c.conclusion === null
  ).length;
  const passed = uniqueChecks.filter((c) => c.conclusion === 'SUCCESS').length;

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
  const getStatusIcon = () => {
    if (check.conclusion === 'SUCCESS') {
      return <span className="text-green-500">✓</span>;
    }
    if (check.conclusion === 'FAILURE') {
      return <span className="text-red-500">✗</span>;
    }
    if (check.conclusion === 'SKIPPED' || check.conclusion === 'CANCELLED') {
      return <span className="text-gray-400">○</span>;
    }
    return <span className="text-yellow-500 animate-pulse">◐</span>;
  };

  const getStatusColor = () => {
    if (check.conclusion === 'SUCCESS') {
      return 'text-green-600';
    }
    if (check.conclusion === 'FAILURE') {
      return 'text-red-600';
    }
    if (check.conclusion === 'SKIPPED' || check.conclusion === 'CANCELLED') {
      return 'text-gray-500';
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

  const passed = uniqueChecks.filter((c) => c.conclusion === 'SUCCESS').length;
  const failed = uniqueChecks.filter((c) => c.conclusion === 'FAILURE').length;
  const pending = uniqueChecks.filter(
    (c) => c.status !== 'COMPLETED' || c.conclusion === null
  ).length;
  const skipped = uniqueChecks.filter(
    (c) => c.conclusion === 'SKIPPED' || c.conclusion === 'CANCELLED'
  ).length;

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
