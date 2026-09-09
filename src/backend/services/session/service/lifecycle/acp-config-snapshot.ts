import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { normalizeSessionConfigOptions } from '../acp/acp-session-config-options';

const extensionMetadataSchema = z.record(z.string(), z.unknown()).nullish();
const selectValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  _meta: extensionMetadataSchema,
});
const selectGroupSchema = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(selectValueSchema),
  _meta: extensionMetadataSchema,
});
const configOptionFields = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  category: z.string().nullish(),
  _meta: extensionMetadataSchema,
};

// ACP 1.4 does not export its Zod validators and silently drops malformed group
// entries internally. Persisted snapshots must reject the whole invalid value.
const storedConfigOptionSchema = z.discriminatedUnion('type', [
  z.object({
    ...configOptionFields,
    type: z.literal('select'),
    currentValue: z.string(),
    options: z.union([z.array(selectValueSchema), z.array(selectGroupSchema)]),
  }),
  z.object({
    ...configOptionFields,
    type: z.literal('boolean'),
    currentValue: z.boolean(),
  }),
]) satisfies z.ZodType<SessionConfigOption>;

const storedAcpConfigSnapshotSchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  providerSessionId: z.string().min(1),
  capturedAt: z.string().catch(new Date(0).toISOString()),
  configOptions: z.array(storedConfigOptionSchema),
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
