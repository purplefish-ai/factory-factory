import type {
  ClaudeSession,
  Prisma,
  Project,
  TerminalSession,
  UserSettings,
  Workspace,
} from '@prisma-gen/client';
import { prisma } from '@/backend/db';

export type DataBackupTransactionClient = Prisma.TransactionClient;

export interface DataBackupSnapshot {
  projects: Project[];
  workspaces: Workspace[];
  claudeSessions: ClaudeSession[];
  terminalSessions: TerminalSession[];
  userSettings: UserSettings | null;
}

class DataBackupAccessor {
  getSnapshotForExport(): Promise<DataBackupSnapshot> {
    return Promise.all([
      prisma.project.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.workspace.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.claudeSession.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.terminalSession.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.userSettings.findFirst({ where: { userId: 'default' } }),
    ]).then(([projects, workspaces, claudeSessions, terminalSessions, userSettings]) => ({
      projects,
      workspaces,
      claudeSessions,
      terminalSessions,
      userSettings,
    }));
  }

  runInTransaction<T>(callback: (tx: DataBackupTransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(callback);
  }
}

export const dataBackupAccessor = new DataBackupAccessor();
