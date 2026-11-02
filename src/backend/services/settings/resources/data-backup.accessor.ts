import { prisma } from '@/backend/db';
import {
  codexAccountMetadataSchema,
  type CodexAccountMetadata,
} from '@/shared/codex-account-backup';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import type {
  AgentSession,
  ClosedSession,
  Prisma,
  Project,
  TerminalSession,
  UserSettings,
} from '@prisma-gen/client';
import { withBackupSnapshot } from './backup-snapshot';
import { readDurableRecovery } from './durable-recovery';

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
  codexAccounts: CodexAccountMetadata[];
  durable: DurableRecovery;
  closedSessions: ClosedSession[];
}

class DataBackupAccessor {
  getSnapshotForExport(): Promise<DataBackupSnapshot> {
    return withBackupSnapshot(prisma, async (tx) => {
      const [projects, workspaces, agentSessions, terminalSessions, userSettings, accounts] =
        await Promise.all([
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
          tx.codexAccount.findMany({
            orderBy: { createdAt: 'asc' },
            select: { id: true, label: true, kind: true, enabled: true, identityKey: true },
          }),
        ]);
      return {
        durable: await readDurableRecovery(tx),
        closedSessions: await tx.closedSession.findMany({ orderBy: { id: 'asc' } }),
        projects,
        workspaces,
        agentSessions,
        terminalSessions,
        userSettings,
        codexAccounts: codexAccountMetadataSchema.array().parse(accounts),
      };
    });
  }

  runInTransaction<T>(callback: (tx: DataBackupTransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(callback);
  }
}

export const dataBackupAccessor = new DataBackupAccessor();
