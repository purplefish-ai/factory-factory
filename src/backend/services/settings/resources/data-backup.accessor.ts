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
 * Version 5 exports include every PR and its dispatch history, including tombstones.
 */
export type WorkspaceForExport = Prisma.WorkspaceGetPayload<{
  include: {
    ratchet: true;
    prDiscovery: true;
    prs: { include: { automation: true } };
    runScript: true;
    autoIteration: true;
    wakeSchedule: true;
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
  getSnapshotForExport(): Promise<DataBackupSnapshot> {
    return Promise.all([
      prisma.project.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.workspace.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          ratchet: true,
          prDiscovery: true,
          prs: { include: { automation: true } },
          runScript: true,
          autoIteration: true,
          wakeSchedule: true,
        },
      }),
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
