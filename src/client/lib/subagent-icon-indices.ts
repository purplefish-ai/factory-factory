import type { SubagentSummary } from '@/shared/acp-protocol';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function timestamp(value: string | null): number {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : Infinity;
}

function releaseClaims(claims: Map<number, number>, start: number): void {
  // Unknown creation times cannot prove that an earlier claim has ended.
  if (!Number.isFinite(start)) {
    return;
  }
  for (const [index, end] of claims) {
    if (end <= start) {
      claims.delete(index);
    }
  }
}

/** Replay icon claims so every surface uses the same lifecycle assignments. */
export function getSubagentIconIndices(
  subagents: readonly Pick<
    SubagentSummary,
    'id' | 'createdAt' | 'status' | 'completedAt' | 'updatedAt'
  >[]
): Map<string, number> {
  const ordered = [...subagents].sort((a, b) => {
    const aTime = timestamp(a.createdAt);
    const bTime = timestamp(b.createdAt);
    return (aTime === bTime ? 0 : aTime - bTime) || a.id.localeCompare(b.id);
  });
  const indices = new Map<string, number>();
  const claims = new Map<number, number>();
  for (const agent of ordered) {
    if (indices.has(agent.id)) {
      continue;
    }
    const start = timestamp(agent.createdAt);
    releaseClaims(claims, start);
    let index = 0;
    while (claims.has(index)) {
      index += 1;
    }
    indices.set(agent.id, index);
    const end = TERMINAL_STATUSES.has(agent.status)
      ? timestamp(agent.completedAt ?? agent.updatedAt)
      : Infinity;
    // Ignore malformed intervals rather than sharing an icon with uncertain work.
    claims.set(index, end >= start ? end : Infinity);
  }
  return indices;
}
