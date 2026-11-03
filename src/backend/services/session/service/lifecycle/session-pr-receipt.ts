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
    const archived = await findArchivedReceipt(sessionId, deliveryId, session);
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
    deliveryId,
    session.codexAccountId
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
      deliveryId,
      session.codexAccountId
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
  session: ReceiptSession | null
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const archives = await closedSessionAccessor.findBySessionIdWithWorkspace(sessionId);
  let unavailable = !session && archives.length === 0;
  for (const archive of archives) {
    try {
      const identity = await sessionDataService.readClosedSessionProviderIdentity(archive.id);
      if (
        identity.provider === 'CODEX' &&
        session?.provider === 'CODEX' &&
        identity.codexAccountId !== session.codexAccountId
      ) {
        unavailable = true;
        continue;
      }
      const receipt = await loadReceipt(
        identity.provider,
        identity.providerSessionId,
        identity.workingDir,
        deliveryId,
        identity.codexAccountId
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
  deliveryId: string,
  codexAccountId?: string | null
): Promise<'delivered' | 'absent' | 'unavailable'> {
  try {
    const marker = prEventMarker(deliveryId);
    // Byte-search the transcript for the marker and parse only matching lines.
    const input = { providerSessionId, workingDir, onlyLinesContaining: marker };
    const result =
      provider === 'CLAUDE'
        ? await claudeSessionHistoryLoaderService.loadSessionHistory(input)
        : await codexSessionHistoryLoaderService.loadSessionHistory({
            ...input,
            ...(codexAccountId ? { codexAccountId } : {}),
          });
    if (result.status !== 'loaded') {
      return 'unavailable';
    }
    return result.history.some(
      (message) => message.type === 'user' && message.content.split('\n').includes(marker)
    )
      ? 'delivered'
      : 'absent';
  } catch {
    return 'unavailable';
  }
}
