import { prEventMarker } from '@/shared/pr-monitoring';
import { codexSessionHistoryLoaderService } from '../data/codex-session-history-loader.service';
import { sessionDataService } from '../data/session-data.service';
import { claudeSessionHistoryLoaderService } from '../data/session-history-loader.service';
export async function findPRDeliveryReceipt(
  sessionId: string,
  deliveryId: string
): Promise<'delivered' | 'absent' | 'unavailable'> {
  const session = await sessionDataService.findAgentSessionById(sessionId);
  if (!(session?.providerSessionId && session.workspace.worktreePath)) {
    return 'unavailable';
  }
  const input = {
    providerSessionId: session.providerSessionId,
    workingDir: session.workspace.worktreePath,
  };
  const result =
    session.provider === 'CLAUDE'
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
