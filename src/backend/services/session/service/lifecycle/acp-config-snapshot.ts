import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { z } from 'zod';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { normalizeSessionConfigOptions } from '@/backend/services/session/service/acp/acp-session-config-options';

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

// ACP select validators silently drop malformed group
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

/** Prefer the committed replacement identity over its captured fallback predecessor. */
export function resolveSavedConfigIdentity(
  session: Pick<AgentSessionRecord, 'providerSessionId'>,
  handle: Pick<AcpProcessHandle, 'providerSessionId' | 'sessionCreationOutcome'>
): string {
  return handle.providerSessionId !== session.providerSessionId &&
    handle.sessionCreationOutcome?.kind === 'resume_fallback'
    ? handle.sessionCreationOutcome.previousProviderSessionId
    : handle.providerSessionId;
}

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
  const configOptions =
    snapshot.provider === 'CODEX'
      ? migrateCodexConfigOptions(snapshot.configOptions)
      : snapshot.configOptions;
  if (!configOptions) {
    return null;
  }
  return {
    ...snapshot,
    configOptions: normalizeSessionConfigOptions(snapshot.provider, configOptions),
  };
}

const legacyExecutionSchema = z.tuple([
  z.enum(['on-request', 'on-failure', 'never', 'untrusted']),
  z.enum(['read-only', 'workspace-write', 'danger-full-access']),
]);

/** Legacy access tuples only migrate to equivalent or more restrictive access. */
function migrateCodexConfigOptions(
  configOptions: SessionConfigOption[]
): SessionConfigOption[] | null {
  const execution = configOptions.find((option) => option.id === 'execution_mode');
  const mode = configOptions.find((option) => option.id === 'mode');
  const legacyCollaboration =
    mode && ['plan', 'code', 'default'].includes(String(mode.currentValue));
  if (!(execution || (legacyCollaboration && mode?.currentValue !== 'default'))) {
    return configOptions;
  }
  if (
    !(execution?.type === 'select' && mode?.type === 'select' && legacyCollaboration) ||
    configOptions.some((option) => option.id === 'collaboration_mode')
  ) {
    return null;
  }
  let tuple: z.infer<typeof legacyExecutionSchema>;
  try {
    tuple = legacyExecutionSchema.parse(JSON.parse(execution.currentValue));
  } catch {
    return null;
  }
  const [approval, sandbox] = tuple;
  if (sandbox === 'danger-full-access' && approval !== 'never') {
    return null;
  }
  const access = sandbox === 'danger-full-access' ? 'agent-full-access' : sandbox;
  const accessOption: SessionConfigOption = {
    id: 'mode',
    name: 'Access',
    category: 'mode',
    type: 'select',
    currentValue: access,
    options: [
      { value: 'read-only', name: 'Read-only' },
      { value: 'workspace-write', name: 'Workspace access' },
      { value: 'agent', name: 'Auto review' },
      { value: 'agent-full-access', name: 'Full access' },
    ],
  };
  const collaborationOption: SessionConfigOption = {
    id: 'collaboration_mode',
    name: 'Planning',
    category: 'collaboration_mode',
    type: 'select',
    currentValue: mode.currentValue === 'plan' ? 'plan' : 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  };
  return configOptions.flatMap((option) =>
    option.id === 'execution_mode'
      ? []
      : option.id === 'mode'
        ? [accessOption, collaborationOption]
        : [option]
  );
}
