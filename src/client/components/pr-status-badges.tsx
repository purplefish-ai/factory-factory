import { useState } from 'react';
import {
  type CheckOutcome,
  getCheckOutcome,
  getCheckPresentation,
  getReviewDecisionPresentation,
} from '@/client/lib/pr-status-presentation';
import { getCiStateTone, getStatusToneStyle } from '@/client/lib/status-tones';
import { Badge } from '@/components/ui/badge';
import {
  type CiVisualState,
  deriveCiVisualStateFromChecks,
  getCiVisualLabel,
  reduceCheckRollupToLatestRunAttempts,
} from '@/shared/core';
import type { GitHubStatusCheck, ReviewDecision } from '@/shared/github-types';
import { StatusChip, StatusDot, StatusIcon } from './status-indicators';

export type CIStatus = CiVisualState;

export function getCIStatus(checks: GitHubStatusCheck[] | null): CIStatus {
  return deriveCiVisualStateFromChecks(checks);
}

function countCheckOutcomes(checks: GitHubStatusCheck[]): Record<CheckOutcome, number> {
  const counts: Record<CheckOutcome, number> = {
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    unknown: 0,
  };
  for (const check of checks) {
    counts[getCheckOutcome(check)] += 1;
  }
  return counts;
}

interface CIStatusDotProps {
  checks: GitHubStatusCheck[] | null;
  size?: 'sm' | 'md';
}

const CI_STATUS_TITLES: Record<CIStatus, string> = {
  PASSING: 'CI passed',
  FAILING: 'CI failed',
  RUNNING: 'Checks running…',
  UNKNOWN: 'CI unknown',
  NONE: 'No checks',
};

export function CIStatusDot({ checks, size = 'sm' }: CIStatusDotProps) {
  const status = getCIStatus(checks);
  return <StatusDot tone={getCiStateTone(status)} size={size} label={CI_STATUS_TITLES[status]} />;
}

// Deduplicate checks by name, keeping the most relevant status
function deduplicateChecks(checks: GitHubStatusCheck[]): GitHubStatusCheck[] {
  const checkMap = new Map<string, GitHubStatusCheck>();
  const latestAttemptChecks = reduceCheckRollupToLatestRunAttempts(checks) ?? checks;

  const priorities: Record<CheckOutcome, number> = {
    failed: 5,
    pending: 4,
    passed: 3,
    skipped: 2,
    unknown: 1,
  };
  const getPriority = (check: GitHubStatusCheck) => priorities[getCheckOutcome(check)];

  for (const check of latestAttemptChecks) {
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

  const { failed, pending, passed, skipped } = countCheckOutcomes(deduplicateChecks(checks));
  if (failed > 0) {
    return <StatusChip tone="danger" icon size="md">{`${failed} failed`}</StatusChip>;
  }
  if (pending > 0) {
    return <StatusChip tone="waiting" icon size="md">{`${pending} pending`}</StatusChip>;
  }
  if (passed > 0) {
    return <StatusChip tone="success" icon size="md">{`${passed} passed`}</StatusChip>;
  }
  if (skipped > 0) {
    return <StatusChip tone="neutral" icon size="md">{`${skipped} skipped`}</StatusChip>;
  }
  return (
    <Badge variant="outline" className="text-xs">
      {getCiVisualLabel('UNKNOWN')}
    </Badge>
  );
}

interface ReviewDecisionBadgeProps {
  decision: ReviewDecision;
}

export function ReviewDecisionBadge({ decision }: ReviewDecisionBadgeProps) {
  const { tone, label } = getReviewDecisionPresentation(decision);
  return (
    <StatusChip tone={tone} size="md">
      {label}
    </StatusChip>
  );
}

interface CICheckItemProps {
  check: GitHubStatusCheck;
}

function CICheckItem({ check }: CICheckItemProps) {
  const { tone, label } = getCheckPresentation(check);
  const content = (
    <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 transition-colors group">
      <span className="w-4 flex-shrink-0 flex justify-center">
        <StatusIcon tone={tone} />
      </span>
      <span className="flex-1 truncate text-sm" title={check.name}>
        {check.name}
      </span>
      <span className={`text-xs ${getStatusToneStyle(tone).text}`}>{label}</span>
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
  const { passed, failed, pending, skipped } = countCheckOutcomes(uniqueChecks);
  const successText = getStatusToneStyle('success').text;
  const dangerText = getStatusToneStyle('danger').text;
  const waitingText = getStatusToneStyle('waiting').text;
  const neutralText = getStatusToneStyle('neutral').text;

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="text-xs text-muted-foreground font-medium">CI CHECKS</span>
        <span className="flex items-center gap-1.5 text-xs">
          {passed > 0 && <span className={successText}>{passed} passed</span>}
          {failed > 0 && <span className={dangerText}>{failed} failed</span>}
          {pending > 0 && <span className={waitingText}>{pending} pending</span>}
          {skipped > 0 && <span className={neutralText}>{skipped} skipped</span>}
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
