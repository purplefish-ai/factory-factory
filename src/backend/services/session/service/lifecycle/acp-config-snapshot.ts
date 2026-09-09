import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { zSessionConfigOption } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import { z } from 'zod';
import { normalizeSessionConfigOptions } from '../acp/acp-session-config-options';

const storedAcpConfigSnapshotSchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  providerSessionId: z.string().min(1),
  capturedAt: z.string().catch(new Date(0).toISOString()),
  configOptions: z.array(zSessionConfigOption),
  observedModelId: z.string().optional().catch(undefined),
});

export type StoredAcpConfigSnapshot = z.infer<typeof storedAcpConfigSnapshotSchema>;

/** Treat invalid persisted config as a cache miss before any protocol consumer sees it. */
export function parseAcpConfigSnapshot(metadata: unknown): StoredAcpConfigSnapshot | null {
  const envelope = z.object({ acpConfigSnapshot: z.unknown() }).safeParse(metadata);
  if (!envelope.success) {
    return null;
  }
  const parsed = storedAcpConfigSnapshotSchema.safeParse(envelope.data.acpConfigSnapshot);
  if (!parsed.success) {
    return null;
  }
  const snapshot = parsed.data;
  const configOptions: SessionConfigOption[] = snapshot.configOptions;
  return {
    ...snapshot,
    configOptions: normalizeSessionConfigOptions(snapshot.provider, configOptions),
  };
}
