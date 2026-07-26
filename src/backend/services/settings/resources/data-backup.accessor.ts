import type {
  AgentSession,
  Prisma,
  Project,
  TerminalSession,
  UserSettings,
} from '@prisma-gen/client';
import { prisma } from '@/backend/db';

export type DataBackupTransactionClient = Prisma.TransactionClient;

/**
 * A workspace as the export format sees it: the row plus its ratchet, which the
 * v4 format carries as flat `ratchet*` workspace fields.
 */
export type WorkspaceForExport = Prisma.WorkspaceGetPayload<{ include: { ratchet: true } }>;

export interface DataBackupSnapshot {
  projects: Project[];
  workspaces: WorkspaceForExport[];
  agentSessions: AgentSession[];
  terminalSessions: TerminalSession[];
  userSettings: UserSettings | null;
}

class DataBackupAccessor {
  getSnapshotForExport(): Promise<DataBackupSnapshot> {
    return Promise.all([
      prisma.project.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.workspace.findMany({ orderBy: { createdAt: 'asc' }, include: { ratchet: true } }),
      prisma.agentSession.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.terminalSession.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.userSettings.findFirst({ where: { userId: 'default' } }),
    ]).then(([projects, workspaces, agentSessions, terminalSessions, userSettings]) => ({
      projects,
      workspaces,
      agentSessions,
      terminalSessions,
      userSettings,
    }));
  }

  runInTransaction<T>(callback: (tx: DataBackupTransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(callback);
  }
}

export const dataBackupAccessor = new DataBackupAccessor();
