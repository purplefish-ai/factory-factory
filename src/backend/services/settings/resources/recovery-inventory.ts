import { ApplicationError } from '@/backend/lib/application-error';
import type { RecoveryImportReport } from '@/shared/recovery-import-report';
export type { RecoveryImportReport } from '@/shared/recovery-import-report';
import { z } from 'zod';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import { Prisma } from '@prisma-gen/client';

const identifier = z.union([z.string(), z.number().int()]);
const record = z.record(z.string(), z.unknown());
type Group = { model: string; table: string; columns: string[]; values: (string | number)[][] };
const compoundKeys: Record<string, string[]> = {
  agentSourceState: ['connectionId'],
  agentSourceCheckpoint: ['connectionId', 'scanId'],
  agentSourceHead: ['connectionId', 'scanId', 'providerEventId'],
  workspaceLaunchOrigin: ['runId'],
  agentSessionLaunchOrigin: ['runId'],
  workspaceChildOrigin: ['parentWorkspaceId', 'childWorkspaceId'],
};
function groups(data: ExportData['data']): Group[] {
  const result: Group[] = [];
  for (const [name, rows] of Object.entries(data.durable ?? {})) {
    if (name === 'jsonStorage' || !Array.isArray(rows)) {
      continue;
    }
    const model = name.charAt(0).toUpperCase() + name.slice(1);
    const columns = compoundKeys[name] ?? ['id'];
    result.push({
      model,
      table: name === 'workspaceNotification' ? 'workspace_notifications' : model,
      columns,
      values: rows.map((row: unknown) => {
        const parsed = record.parse(row);
        return columns.map((column) => identifier.parse(parsed[column]));
      }),
    });
  }
  if (data.archives) {
    result.push({
      model: 'ClosedSession',
      table: 'ClosedSession',
      columns: ['id'],
      values: data.archives.entries.map((row) => [row.id]),
    });
  }
  return result;
}
// Names come exclusively from the parsed strict durable schema and fixed column map.
const quoted = (name: string) => Prisma.raw(`"${name}"`);
async function existing(tx: Prisma.TransactionClient, group: Group): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < group.values.length; start += 200) {
    const keys = group.values.slice(start, start + 200);
    const columns = Prisma.join(group.columns.map(quoted));
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
