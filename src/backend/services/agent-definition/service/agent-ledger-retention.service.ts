import {
  agentLedgerRetentionAccessor,
  type RetentionBatch,
  type RetentionKind,
} from '@/backend/services/agent-definition/resources/agent-ledger-retention.accessor';

/** Existing maintenance owns this instance; each cursor publishes only after commit. */
export class AgentLedgerRetentionService {
  private readonly cursors: Record<RetentionKind, string | null> = {
    evaluation: null,
    payload: null,
    identity: null,
  };

  async pruneExpired(signal: AbortSignal): Promise<RetentionBatch[]> {
    const batches: RetentionBatch[] = [];
    for (const kind of ['evaluation', 'payload', 'identity'] as const) {
      if (signal.aborted) {
        break;
      }
      try {
        const batch = await agentLedgerRetentionAccessor.pruneBatch(kind, this.cursors[kind], () =>
          signal.throwIfAborted()
        );
        this.cursors[kind] = batch.cursor;
        batches.push(batch);
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        throw error;
      }
    }
    return batches;
  }
}
