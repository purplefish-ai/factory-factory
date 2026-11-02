import {
  agentLedgerRetentionAccessor,
  type RetentionBatch,
  type RetentionKind,
} from '@/backend/services/agent-definition/resources/agent-ledger-retention.accessor';
import { agentRunContextRetentionAccessor } from '@/backend/services/agent-definition/resources/agent-run-context-retention.accessor';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { inspectAgentRunContextsInputSchema } from '@/shared/agent-run-context';

const logger = createLogger('agent-ledger-retention');

/** Existing maintenance owns this instance; each cursor publishes only after commit. */
export class AgentLedgerRetentionService {
  private readonly cursors: Record<RetentionKind, string | null> = {
    evaluation: null,
    payload: null,
    identity: null,
    runContext: null,
  };

  /** Preview does not opt into expiry or advance the maintenance cursor. */
  inspectRunContexts(input: unknown, signal: AbortSignal) {
    const parsed = inspectAgentRunContextsInputSchema.parse(input);
    signal.throwIfAborted();
    return agentRunContextRetentionAccessor.inspectBatch(parsed, () => signal.throwIfAborted());
  }

  async pruneExpired(signal: AbortSignal): Promise<RetentionBatch[]> {
    const batches: RetentionBatch[] = [];
    const kinds: RetentionKind[] = ['evaluation', 'payload', 'identity'];
    if (configService.getAgentRuntimeLimits().runContextRetentionMs !== null) {
      kinds.push('runContext');
    }
    for (const kind of kinds) {
      if (signal.aborted) {
        break;
      }
      try {
        const assertCurrent = () => signal.throwIfAborted();
        const batch =
          kind === 'runContext'
            ? await agentRunContextRetentionAccessor.pruneBatch(this.cursors[kind], assertCurrent)
            : await agentLedgerRetentionAccessor.pruneBatch(
                kind,
                this.cursors[kind],
                assertCurrent
              );
        this.cursors[kind] = batch.cursor;
        batches.push(batch);
        if (kind === 'runContext' && batch.inspected > 0) {
          logger.debug('Terminal run context retention batch', {
            inspected: batch.inspected,
            changed: batch.changed,
            retained: batch.retained,
          });
        }
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
