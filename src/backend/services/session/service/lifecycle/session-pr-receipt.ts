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
  try {
    const session = await sessionDataService.findAgentSessionById(sessionId);
    const live = session ? await findLiveReceipt(session, deliveryId) : 'absent';
    if (live === 'delivered') {
      return live;
    }
    const rollovers = session ? await findRolloverReceipt(session, deliveryId) : 'absent';
    if (rollovers === 'delivered') {
      return rollovers;
    }
    const archived = await findArchivedReceipt(sessionId, deliveryId, !session);
    if (archived === 'delivered') {
      return archived;
    }
    return [live, rollovers, archived].includes('unavailable') ? 'unavailable' : 'absent';
  } catch {
    return 'unavailable';
  }
}

type ReceiptSession = NonNullable<
  Awaited<ReturnType<typeof sessionDataService.findAgentSessionById>>
>;

async function findLiveReceipt(session: ReceiptSession, deliveryId: string) {
  if (!(session.providerSessionId && session.workspace.worktreePath)) {
    return 'unavailable' as const;
  }
  return await loadReceipt(
    session.provider,
    session.providerSessionId,
    session.workspace.worktreePath,
    deliveryId
  );
}

async function findRolloverReceipt(
  session: ReceiptSession,
  deliveryId: string
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const rollovers = z
    .object({
      providerIdentityRollovers: z
        .array(z.object({ previousProviderSessionId: z.string().min(1) }))
        .optional(),
    })
    .safeParse(session.providerMetadata ?? {});
  if (!rollovers.success) {
    return 'unavailable';
  }
  if (!session.workspace.worktreePath) {
    return 'unavailable';
  }
  let unavailable = false;
  for (const rollover of rollovers.data.providerIdentityRollovers ?? []) {
    const receipt = await loadReceipt(
      session.provider,
      rollover.previousProviderSessionId,
      session.workspace.worktreePath,
      deliveryId
    );
    if (receipt === 'delivered') {
      return receipt;
    }
    unavailable ||= receipt === 'unavailable';
  }
  return unavailable ? 'unavailable' : 'absent';
}

async function findArchivedReceipt(
  sessionId: string,
  deliveryId: string,
  unavailableWhenEmpty = true
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const archives = await closedSessionAccessor.findBySessionIdWithWorkspace(sessionId);
  let unavailable = unavailableWhenEmpty && archives.length === 0;
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
  try {
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
  } catch {
    return 'unavailable';
  }
}
