import { z } from 'zod';
import { prisma } from '@/backend/db';
import type { BaseJsonSection } from '@/shared/schemas/recovery-json-storage.schema';
import type {
  AgentSession,
  Prisma,
  Project,
  TerminalSession,
  UserSettings,
} from '@prisma-gen/client';
import { withBackupImport, withBackupSnapshot } from './backup-snapshot';

export type DataBackupTransactionClient = Prisma.TransactionClient;

/**
 * A workspace as the export format sees it: the row plus its ratchet, which the
 * v4 format carries as flat `ratchet*` workspace fields.
 */
export type WorkspaceForExport = Prisma.WorkspaceGetPayload<{
  include: {
    conversationMetadata: true;
    prMonitoring: true;
    prEvents: true;
    prDeliveries: true;
    prDiscovery: true;
    prs: { include: { dedicatedSession: true } };
    runScript: true;
  };
}>;

export interface DataBackupSnapshot {
  projects: Project[];
  workspaces: WorkspaceForExport[];
  agentSessions: AgentSession[];
  terminalSessions: TerminalSession[];
  userSettings: UserSettings | null;
}

class DataBackupAccessor {
  withExportSnapshot<T>(callback: (tx: DataBackupTransactionClient) => Promise<T>): Promise<T> {
    return withBackupSnapshot(prisma, callback);
  }

  async getBaseJsonStorageForExport(
    tx: DataBackupTransactionClient
  ): Promise<BaseJsonSection['jsonStorage']> {
    const rows = z
      .array(z.strictObject({ id: z.string() }))
      .parse(
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE json_type("creationMetadata") = 'null'`
      );
    return rows.map(({ id }) => ({
      model: 'Workspace',
      identity: [id],
      field: 'creationMetadata',
    }));
  }

  getSnapshotForExport(tx: DataBackupTransactionClient): Promise<DataBackupSnapshot> {
    return Promise.all([
      tx.project.findMany({ orderBy: { createdAt: 'asc' } }),
      tx.workspace.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          conversationMetadata: true,
          prMonitoring: true,
          prEvents: true,
          prDeliveries: true,
          prDiscovery: true,
          prs: { include: { dedicatedSession: true } },
          runScript: true,
        },
      }),
      tx.agentSession.findMany({ orderBy: { createdAt: 'asc' } }),
      tx.terminalSession.findMany({ orderBy: { createdAt: 'asc' } }),
      tx.userSettings.findFirst({ where: { userId: 'default' } }),
    ]).then(([projects, workspaces, agentSessions, terminalSessions, userSettings]) => ({
      projects,
      workspaces,
      agentSessions,
      terminalSessions,
      userSettings,
    }));
  }

  runInTransaction<T>(callback: (tx: DataBackupTransactionClient) => Promise<T>): Promise<T> {
    return withBackupImport(prisma, callback);
  }
}

export const dataBackupAccessor = new DataBackupAccessor();
