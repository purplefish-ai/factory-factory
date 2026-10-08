import { workspaceRatchetService } from '@/backend/services/workspace';
import type { WorkspaceRatchetResult, WorkspaceWithPR } from './ratchet.types';
export async function checkRatchetCandidates(
  workspaces: WorkspaceWithPR[],
  check: (workspace: WorkspaceWithPR) => Promise<WorkspaceRatchetResult>
): Promise<WorkspaceRatchetResult[]> {
  const groups = new Map<string, WorkspaceWithPR[]>();
  for (const workspace of workspaces) {
    const group = groups.get(workspace.id) ?? [];
    group.push(workspace);
    groups.set(workspace.id, group);
  }
  const batches = await Promise.all(
    [...groups.values()].map((group) =>
      (async () => {
        const results: WorkspaceRatchetResult[] = [];
        for (const candidate of group) {
          const fresh =
            group.length === 1
              ? candidate
              : await workspaceRatchetService.findCandidateById(candidate.id, candidate.prId);
          if (fresh) {
            results.push(await check(fresh));
          }
        }
        return results;
      })()
    )
  );
  const results = batches.flat();

  return results;
}
