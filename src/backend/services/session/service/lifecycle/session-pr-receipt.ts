import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { closedSessionAccessor } from '@/backend/services/session/resources/closed-session.accessor';
import { codexSessionHistoryLoaderService } from '@/backend/services/session/service/data/codex-session-history-loader.service';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { claudeSessionHistoryLoaderService } from '@/backend/services/session/service/data/session-history-loader.service';
import { prEventMarker } from '@/shared/pr-monitoring';
export async function findPRDeliveryReceipt(
  sessionId: string,
  deliveryId: string
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const session = await sessionDataService.findAgentSessionById(sessionId);
  if (!(session?.providerSessionId && session.workspace.worktreePath)) {
    if (session) {
      return 'unavailable';
    }
    return findArchivedReceipt(sessionId, deliveryId);
  }
  return loadReceipt(
    session.provider,
    session.providerSessionId,
    session.workspace.worktreePath,
    deliveryId
  );
}
async function findArchivedReceipt(
  sessionId: string,
  deliveryId: string
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const archives = await closedSessionAccessor.findBySessionIdWithWorkspace(sessionId);
  let unavailable = archives.length === 0;
  for (const archive of archives) {
    try {
      if (!archive.workspace.worktreePath) {
        unavailable = true;
        continue;
      }
      const metadata = z
        .object({
          sessionId: z.literal(sessionId),
          metadata: z.object({
            provider: z.enum(['CLAUDE', 'CODEX']),
            providerSessionId: z.string().min(1),
          }),
        })
        .parse(
          JSON.parse(
            await readFile(join(archive.workspace.worktreePath, archive.transcriptPath), 'utf-8')
          )
        );
      if (metadata.metadata.provider !== archive.provider) {
        unavailable = true;
        continue;
      }
      const receipt = await loadReceipt(
        metadata.metadata.provider,
        metadata.metadata.providerSessionId,
        archive.workspace.worktreePath,
        deliveryId
      );
      if (receipt === 'delivered') {
        return receipt;
      }
      unavailable ||= receipt === 'unavailable';
    } catch {
      unavailable = true;
    }
  }
  return unavailable ? 'unavailable' : 'absent';
}
async function loadReceipt(
  provider: 'CLAUDE' | 'CODEX',
  providerSessionId: string,
  workingDir: string,
  deliveryId: string
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const input = {
    providerSessionId,
    workingDir,
  };
  const result =
    provider === 'CLAUDE'
      ? await claudeSessionHistoryLoaderService.loadSessionHistory(input)
      : await codexSessionHistoryLoaderService.loadSessionHistory(input);
  if (result.status !== 'loaded') {
    return 'unavailable';
  }
  const marker = prEventMarker(deliveryId);
  return result.history.some(
    (message) => message.type === 'user' && message.content.split('\n').includes(marker)
  )
    ? 'delivered'
    : 'absent';
}
