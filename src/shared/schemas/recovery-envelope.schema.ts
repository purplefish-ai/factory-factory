import { z } from 'zod';
import {
  periodicConfigRecoverySchema,
  periodicHistoryRecoverySchema,
} from './periodic-recovery.schema';
import { baseJsonSectionSchema } from './recovery-json-storage.schema';

const coverageEntrySchema = z.strictObject({
  model: z.string(),
  status: z.enum(['PARTIAL', 'EXCLUDED']),
  limitation: z.string(),
});
type Coverage = Omit<z.infer<typeof coverageEntrySchema>, 'model'>;
const partial = (limitation: string): Coverage => ({ status: 'PARTIAL', limitation });
const excluded = (limitation: string): Coverage => ({ status: 'EXCLUDED', limitation });

// Frozen base-1 profile: importer compatibility must not depend on today's registry.
export const r4aModelCoverage = {
  Project: partial(
    'configuration/paths; no encrypted tracker configuration restore or repository files.'
  ),
  Workspace: partial(
    'base metadata; worktree contents, complete origin history and live workflow/process authority excluded; physical nullable-JSON fidelity unproven.'
  ),
  WorkspaceMetadata: partial(
    'existing generated summaries/provenance fields when parent is accepted; no full-domain recovery claim.'
  ),
  WorkspaceRunScript: partial(
    'command/cleanup and inert runtime disposition; postRunCommand absent and PID/port/start authority excluded.'
  ),
  CodexAccount: partial(
    'identity/label metadata; owner may remap identity; native home, credentials, timestamps and executable login authority excluded.'
  ),
  AgentSession: partial(
    'base metadata/provider history identities; provider history bytes/live process and physical nullable-JSON fidelity excluded.'
  ),
  TerminalSession: partial('label/metadata; process identities and terminal bytes excluded.'),
  UserSettings: partial(
    'exported preference subset; keys, credentials, workspace ordering and caches excluded.'
  ),
  WorkspacePR: partial(
    'existing associations/cache; no exact normalized full ledger guarantee and physical nullable-JSON fidelity unproven.'
  ),
  WorkspacePRMonitoring: partial(
    'base configuration/history; restored disabled, no executable monitoring authority.'
  ),
  WorkspacePRDedicatedSession: partial(
    'existing base association where valid accepted owner graph exists; not an independent session/history payload.'
  ),
  WorkspacePREvent: partial(
    'flattened raw event/effect evidence; no proof of omitted original members or original frozen ordering; unfinished effects inert.'
  ),
  WorkspacePRDelivery: partial(
    'only evidence represented through base events; exact normalized delivery/membership/order not included.'
  ),
  WorkspacePRDiscovery: partial(
    'base scheduling/cache fields where present; defaults otherwise, not delivery authority or full retained history.'
  ),
  DecisionLog: excluded('generic decision history absent.'),
  WorkspaceLaunchOrigin: excluded('original launch provenance absent.'),
  WorkspaceChildOrigin: excluded(
    'original retained/deleted-child provenance absent; import-created invalidation/origin bookkeeping is not source recovery.'
  ),
  WorkspaceNotification: excluded(
    'retained mailbox rows/revision/read/ack/supersession history absent.'
  ),
  WorkspaceMailState: excluded(
    'retained wake/cursor proof absent; live claims/leases are intentionally never restored.'
  ),
  AgentSessionLaunchOrigin: excluded('original session launch provenance absent.'),
  SessionLifecycleEvent: excluded('lifecycle history absent.'),
  ClosedSession: excluded('archive payload/metadata recovery absent.'),
  PeriodicTask: excluded('periodic configuration absent.'),
  PeriodicTaskExecution: excluded('periodic history absent.'),
  AgentDefinition: excluded('automation definitions absent.'),
  AgentConnection: excluded('automation connection configuration absent; secrets excluded.'),
  AgentTrigger: excluded('automation trigger configuration absent.'),
  AgentRun: excluded('automation run/effect history absent.'),
  AgentProposal: excluded('draft/accepted proposal provenance absent.'),
  AgentSourceState: excluded('source continuity state absent.'),
  AgentSourcePage: excluded('source pages absent.'),
  AgentSourceBaseline: excluded('source baselines absent.'),
  AgentSourceCheckpoint: excluded('source checkpoint proof absent.'),
  AgentSourceHead: excluded('source head proof absent.'),
  AgentEvent: excluded('automation retained events absent.'),
  AgentEvaluation: excluded('frozen automation decisions absent.'),
  AgentInitialDelivery: excluded('initial automation effect evidence absent.'),
} as const;

export const workspaceJsonModelCoverage = {
  ...r4aModelCoverage,
  Workspace: partial(
    'base metadata; Workspace.creationMetadata preserves SQL NULL versus top-level JSON null; worktree contents, complete origin history and live workflow/process authority excluded; WorkspacePR.observation and AgentSession.providerMetadata physical nullable-JSON fidelity unproven.'
  ),
};
export const baseJsonModelCoverage = {
  ...r4aModelCoverage,
  Workspace: partial(
    'base metadata; Workspace.creationMetadata preserves SQL NULL versus top-level JSON null; worktree contents, complete origin history and live workflow/process authority excluded.'
  ),
  WorkspacePR: partial(
    'existing associations/cache; WorkspacePR.observation preserves SQL NULL versus top-level JSON null for actual included PR rows; no exact normalized full ledger guarantee.'
  ),
  AgentSession: partial(
    'base metadata/provider history identities; AgentSession.providerMetadata preserves SQL NULL versus top-level JSON null; provider history bytes/live process excluded.'
  ),
};
export const periodicConfigModelCoverage = {
  ...baseJsonModelCoverage,
  PeriodicTask: partial(
    'complete scalar configuration and timestamps; restored disabled; source enabled state is reported, not restored as scheduling authority; periodic execution history excluded.'
  ),
};
export const periodicLinksModelCoverage = {
  ...periodicConfigModelCoverage,
  Workspace: partial(
    'base metadata; Workspace.periodicTaskId links to newly imported disabled tasks; Workspace.creationMetadata preserves SQL NULL versus top-level JSON null; worktree contents, complete origin history and live workflow/process authority excluded.'
  ),
};
export const periodicHistoryModelCoverage = {
  ...periodicLinksModelCoverage,
  PeriodicTask: partial(
    'complete scalar configuration and timestamps; restored disabled; source enabled state is reported, not restored as scheduling authority.'
  ),
  PeriodicTaskExecution: partial(
    'all supported retained execution scalars and canonical version-1 or legacy null launch snapshots with SQL NULL versus top-level JSON null fidelity; imported RUNNING rows become historical FAILED without asserting provider outcome; live execution and replay authority excluded.'
  ),
};
const exclusions = [
  'SECRETS_AND_ENCRYPTION_KEYS',
  'NATIVE_ACCOUNT_HOMES',
  'WORKTREE_AND_REPOSITORY_CONTENTS',
  'PROVIDER_OWNED_HISTORY',
  'LIVE_PROCESS_IDS_AND_RUNTIME_LEASES',
  'PHYSICAL_NULLABLE_JSON_FIDELITY',
] as const;
export const recoverySectionsSchema = z.strictObject({
  baseJson: baseJsonSectionSchema.optional(),
  periodicConfig: periodicConfigRecoverySchema.optional(),
  periodicHistory: periodicHistoryRecoverySchema.optional(),
});
export const recoveryMetadataSchema = z
  .strictObject({
    version: z.literal(1),
    profile: z.enum([
      'base-1',
      'base-json-workspace-1',
      'base-json-1',
      'base-json-periodic-config-1',
      'base-json-periodic-links-1',
      'base-json-periodic-history-1',
    ]),
    status: z.literal('PARTIAL'),
    capabilities: z.strictObject({
      baseJson: z.literal(1).optional(),
      periodicConfig: z.literal(1).optional(),
      periodicHistory: z.literal(1).optional(),
    }),
    coverage: z.array(coverageEntrySchema),
    exclusions: z.array(z.enum(exclusions)),
  })
  .superRefine((metadata, ctx) => {
    const workspaceJson = metadata.profile !== 'base-1';
    const periodic = [
      'base-json-periodic-config-1',
      'base-json-periodic-links-1',
      'base-json-periodic-history-1',
    ].includes(metadata.profile);
    const history = metadata.profile === 'base-json-periodic-history-1';
    if (
      history !== Object.hasOwn(metadata.capabilities, 'periodicHistory') ||
      (history && metadata.capabilities.periodicHistory !== 1)
    ) {
      ctx.addIssue({ code: 'custom', message: 'History profile capabilities do not match' });
    }
    if (
      periodic !== Object.hasOwn(metadata.capabilities, 'periodicConfig') ||
      (periodic && metadata.capabilities.periodicConfig !== 1)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Periodic profile capabilities do not match' });
    }
    if (
      workspaceJson !== Object.hasOwn(metadata.capabilities, 'baseJson') ||
      (workspaceJson && metadata.capabilities.baseJson !== 1)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Profile capabilities do not match' });
    }
  })
  .superRefine((metadata, ctx) => {
    const full = !['base-1', 'base-json-workspace-1'].includes(metadata.profile);
    const expected = new Map<string, Coverage>(
      Object.entries(
        {
          'base-1': r4aModelCoverage,
          'base-json-workspace-1': workspaceJsonModelCoverage,
          'base-json-1': baseJsonModelCoverage,
          'base-json-periodic-config-1': periodicConfigModelCoverage,
          'base-json-periodic-links-1': periodicLinksModelCoverage,
          'base-json-periodic-history-1': periodicHistoryModelCoverage,
        }[metadata.profile]
      )
    );
    for (const entry of metadata.coverage) {
      const canonical = expected.get(entry.model);
      if (
        !canonical ||
        canonical.status !== entry.status ||
        canonical.limitation !== entry.limitation
      ) {
        ctx.addIssue({ code: 'custom', message: `Invalid base-1 classification: ${entry.model}` });
      }
      expected.delete(entry.model);
    }
    if (expected.size) {
      ctx.addIssue({ code: 'custom', message: 'Missing base-1 model classifications' });
    }
    if (
      metadata.exclusions.length !== exclusions.length - Number(full) ||
      new Set(metadata.exclusions).size !== exclusions.length - Number(full) ||
      (full && metadata.exclusions.includes('PHYSICAL_NULLABLE_JSON_FIDELITY'))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly the base-1 global exclusions are required',
      });
    }
  });
export type RecoveryMetadata = z.infer<typeof recoveryMetadataSchema>;
