/** Use the same session-wide creation order in the list and lifecycle timeline. */
export function getSubagentIconIndices(
  subagents: readonly { id: string; createdAt: string | null }[]
): Map<string, number> {
  const createdTime = (value: string | null) => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  };
  const ordered = [...subagents].sort(
    (a, b) => createdTime(a.createdAt) - createdTime(b.createdAt) || a.id.localeCompare(b.id)
  );
  const indices = new Map<string, number>();
  for (const agent of ordered) {
    if (!indices.has(agent.id)) {
      indices.set(agent.id, indices.size);
    }
  }
  return indices;
}
