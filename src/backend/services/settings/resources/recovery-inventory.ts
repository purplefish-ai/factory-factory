import { ApplicationError } from '@/backend/lib/application-error';
import type { RecoveryImportReport } from '@/shared/recovery-import-report';
export type { RecoveryImportReport } from '@/shared/recovery-import-report';
import { z } from 'zod';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import { Prisma } from '@prisma-gen/client';

const identifier = z.union([z.string(), z.number().int()]);
const record = z.record(z.string(), z.unknown());
type ScalarField<Model extends Prisma.ModelName> = Extract<
  keyof Prisma.TypeMap['model'][Model]['payload']['scalars'],
  string
>;
type DurableKey = Exclude<keyof DurableRecovery, 'jsonStorage'>;
type DurableRow<Key extends DurableKey> = DurableRecovery[Key] extends readonly (infer Row)[]
  ? Row
  : never;
type DurableDescriptors = {
  [Key in DurableKey]: {
    model: Prisma.ModelName;
    table: string;
    keys: readonly { field: Extract<keyof DurableRow<Key>, string>; column: string }[];
  };
};
function descriptor<
  const Model extends Prisma.ModelName,
  const Table extends string,
  const Keys extends readonly [
    { field: ScalarField<NoInfer<Model>>; column: string },
    ...{ field: ScalarField<NoInfer<Model>>; column: string }[],
  ],
>(model: Model, table: Table, keys: Keys, identity: 'primary' | 'unique' = 'primary') {
  return { model, table, keys, identity };
}

// Wire groups never supply SQL identifiers. Every model/table/ordered unique
// key is explicit, scalar-checked by Prisma, and exhaustively keyed by the wire.
// Independent schema + migrated SQLite coverage verifies @map/@@map and primary/unique keys.
export const durableRecoveryInventoryDescriptors = {
  agentSourceCheckpoint: descriptor('AgentSourceCheckpoint', 'AgentSourceCheckpoint', [
    { field: 'connectionId', column: 'connectionId' },
    { field: 'scanId', column: 'scanId' },
  ]),
  agentSourceHead: descriptor('AgentSourceHead', 'AgentSourceHead', [
    { field: 'connectionId', column: 'connectionId' },
    { field: 'scanId', column: 'scanId' },
    { field: 'providerEventId', column: 'providerEventId' },
  ]),
  // Numeric IDs are installation-local ordering. Frozen members use this unique identity.
  chatIntent: descriptor(
    'ChatIntent',
    'ChatIntent',
    [
      { field: 'sessionId', column: 'sessionId' },
      { field: 'messageId', column: 'messageId' },
    ],
    'unique'
  ),
  promptDispatchAttempt: descriptor('PromptDispatchAttempt', 'PromptDispatchAttempt', [
    { field: 'id', column: 'id' },
  ]),
  periodicTask: descriptor('PeriodicTask', 'PeriodicTask', [{ field: 'id', column: 'id' }]),
  periodicTaskExecution: descriptor('PeriodicTaskExecution', 'PeriodicTaskExecution', [
    { field: 'id', column: 'id' },
  ]),
  agentDefinition: descriptor('AgentDefinition', 'AgentDefinition', [
    { field: 'id', column: 'id' },
  ]),
  agentConnection: descriptor('AgentConnection', 'AgentConnection', [
    { field: 'id', column: 'id' },
  ]),
  agentTrigger: descriptor('AgentTrigger', 'AgentTrigger', [{ field: 'id', column: 'id' }]),
  agentRun: descriptor('AgentRun', 'AgentRun', [{ field: 'id', column: 'id' }]),
  agentProposal: descriptor('AgentProposal', 'AgentProposal', [{ field: 'id', column: 'id' }]),
  agentSourceState: descriptor('AgentSourceState', 'AgentSourceState', [
    { field: 'connectionId', column: 'connectionId' },
  ]),
  agentSourcePage: descriptor('AgentSourcePage', 'AgentSourcePage', [
    { field: 'id', column: 'id' },
  ]),
  agentSourceBaseline: descriptor('AgentSourceBaseline', 'AgentSourceBaseline', [
    { field: 'id', column: 'id' },
  ]),
  agentEvent: descriptor('AgentEvent', 'AgentEvent', [{ field: 'id', column: 'id' }]),
  agentEvaluation: descriptor('AgentEvaluation', 'AgentEvaluation', [
    { field: 'id', column: 'id' },
  ]),
  agentInitialDelivery: descriptor('AgentInitialDelivery', 'AgentInitialDelivery', [
    { field: 'id', column: 'id' },
  ]),
  workspaceNotification: descriptor('WorkspaceNotification', 'workspace_notifications', [
    { field: 'id', column: 'id' },
  ]),
  workspaceLaunchOrigin: descriptor('WorkspaceLaunchOrigin', 'WorkspaceLaunchOrigin', [
    { field: 'runId', column: 'runId' },
  ]),
  workspaceChildOrigin: descriptor('WorkspaceChildOrigin', 'WorkspaceChildOrigin', [
    { field: 'parentWorkspaceId', column: 'parentWorkspaceId' },
    { field: 'childWorkspaceId', column: 'childWorkspaceId' },
  ]),
  agentSessionLaunchOrigin: descriptor('AgentSessionLaunchOrigin', 'AgentSessionLaunchOrigin', [
    { field: 'runId', column: 'runId' },
  ]),
  sessionLifecycleEvent: descriptor('SessionLifecycleEvent', 'SessionLifecycleEvent', [
    { field: 'id', column: 'id' },
  ]),
  decisionLog: descriptor('DecisionLog', 'DecisionLog', [{ field: 'id', column: 'id' }]),
} satisfies DurableDescriptors;
export const archiveRecoveryInventoryDescriptor = descriptor('ClosedSession', 'ClosedSession', [
  { field: 'id', column: 'id' },
]);

export const sessionRecoveryInventoryDescriptor = descriptor('AgentSession', 'AgentSession', [
  { field: 'id', column: 'id' },
]);

export const prRecoveryInventoryDescriptors = {
  workspacePR: descriptor('WorkspacePR', 'WorkspacePR', [{ field: 'id', column: 'id' }]),
  workspacePRDedicatedSession: descriptor(
    'WorkspacePRDedicatedSession',
    'WorkspacePRDedicatedSession',
    [{ field: 'prId', column: 'prId' }]
  ),
  workspacePRDelivery: descriptor('WorkspacePRDelivery', 'WorkspacePRDelivery', [
    { field: 'id', column: 'id' },
  ]),
  workspacePREvent: descriptor('WorkspacePREvent', 'WorkspacePREvent', [
    { field: 'id', column: 'id' },
  ]),
};

type InventoryDescriptor =
  | (typeof durableRecoveryInventoryDescriptors)[DurableKey]
  | typeof archiveRecoveryInventoryDescriptor
  | typeof sessionRecoveryInventoryDescriptor
  | (typeof prRecoveryInventoryDescriptors)[keyof typeof prRecoveryInventoryDescriptors];
type Group = InventoryDescriptor & { values: (string | number)[][] };
type StaticIdentifier =
  | InventoryDescriptor['table']
  | InventoryDescriptor['keys'][number]['column'];
function isDurableKey(key: string): key is DurableKey {
  return Object.hasOwn(durableRecoveryInventoryDescriptors, key);
}
function groups(data: ExportData['data']): Group[] {
  const result: Group[] = [];
  if (data.durable) {
    for (const name of Object.keys(durableRecoveryInventoryDescriptors)) {
      if (!isDurableKey(name)) {
        throw new Error('Unknown recovery inventory descriptor');
      }
      const entry = durableRecoveryInventoryDescriptors[name];
      result.push({
        ...entry,
        values: data.durable[name].map((row) => {
          const parsed = record.parse(row);
          return entry.keys.map(({ field }) => identifier.parse(parsed[field]));
        }),
      });
    }
  }
  if (data.archives) {
    result.push({
      ...archiveRecoveryInventoryDescriptor,
      values: data.archives.entries.map((row) => [row.id]),
    });
  }
  result.push({
    ...sessionRecoveryInventoryDescriptor,
    values: data.agentSessions.map((row) => [row.id]),
  });
  const prs = data.workspaces.flatMap((workspace) => workspace.prs);
  result.push({
    ...prRecoveryInventoryDescriptors.workspacePR,
    values: prs.map((row) => [row.id]),
  });
  result.push({
    ...prRecoveryInventoryDescriptors.workspacePRDedicatedSession,
    values: prs
      .filter((row) => row.dedicatedSession !== null && row.dedicatedSession !== undefined)
      .map((row) => [row.id]),
  });
  result.push({
    ...prRecoveryInventoryDescriptors.workspacePRDelivery,
    values: [
      ...new Set(
        data.workspaces.flatMap((workspace) => [
          ...(workspace.prRecovery?.deliveries ?? []).map((row) => row.id),
          ...(workspace.prRecovery?.events ?? workspace.prEvents).flatMap((row) =>
            row.deliveryId ? [row.deliveryId] : []
          ),
        ])
      ),
    ].map((id) => [id]),
  });
  result.push({
    ...prRecoveryInventoryDescriptors.workspacePREvent,
    values: data.workspaces.flatMap((workspace) =>
      (workspace.prRecovery?.events ?? workspace.prEvents).map((row) => [row.id])
    ),
  });
  return result;
}
const quoted = (name: StaticIdentifier) => Prisma.raw(`"${name}"`);
async function existing(tx: Prisma.TransactionClient, group: Group): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < group.values.length; start += 200) {
    const keys = group.values.slice(start, start + 200);
    const columns = Prisma.join(group.keys.map(({ column }) => quoted(column)));
    const predicates = keys.map((key) => Prisma.sql`(${Prisma.join(key)})`);
    const rows = z.array(z.object({ identity: z.string() })).parse(
      await tx.$queryRaw`
      SELECT json_array(${columns}) AS identity FROM ${quoted(group.table)}
      WHERE (${columns}) IN (${Prisma.join(predicates)})
    `
    );
    for (const row of rows) {
      found.add(row.identity);
    }
  }
  return found;
}
export async function readRecoveryInventory(
  tx: Prisma.TransactionClient,
  data: ExportData['data']
) {
  const inventory = new Map<string, Set<string>>();
  for (const group of groups(data)) {
    inventory.set(group.model, await existing(tx, group));
  }
  return inventory;
}
export async function reportRecoveryImport(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  before: ReadonlyMap<string, ReadonlySet<string>>
): Promise<RecoveryImportReport> {
  const report: RecoveryImportReport = { models: [], skipped: [] };
  for (const group of groups(data)) {
    const prior = before.get(group.model) ?? new Set<string>();
    const after = await existing(tx, group);
    summarizeGroup(report, group, prior, after);
  }
  return report;
}

function summarizeGroup(
  report: RecoveryImportReport,
  group: Group,
  prior: ReadonlySet<string>,
  after: ReadonlySet<string>
) {
  let imported = 0;
  for (const values of group.values) {
    const key = JSON.stringify(values);
    if (!prior.has(key) && after.has(key)) {
      imported++;
    } else {
      report.skipped.push({
        model: group.model,
        identity: values.length === 1 ? String(values[0]) : key,
        reason: prior.has(key) ? 'EXISTING_IDENTITY' : 'CONFLICTING_IDENTITY_OR_PARENT',
      });
    }
  }
  report.models.push({ model: group.model, imported, skipped: group.values.length - imported });
}

export function validateRecoveryIdentityUniqueness(data: ExportData['data']): void {
  for (const group of groups(data)) {
    const seen = new Set<string>();
    for (const values of group.values) {
      const identity = JSON.stringify(values);
      if (seen.has(identity)) {
        throw new ApplicationError(
          'INVALID_INPUT',
          `Duplicate recovery identity ${group.model}: ${identity}`
        );
      }
      seen.add(identity);
    }
  }
}
