import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';

it('retires loop metadata while preserving workspaces, sessions and worktree references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-retire-loop-'));
  const databasePath = join(dir, 'migration.db');
  const migrationsPath = join(dir, 'migrations');
  const source = join(process.cwd(), 'prisma/migrations');
  const migration = '20261029120000_remove_auto_iteration';
  let db: Database.Database | undefined;
  const migrate = () =>
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* Silence migration logs for this fixture. */
      },
    });
  try {
    for (const name of readdirSync(source)) {
      if (name < migration) {
        cpSync(join(source, name), join(migrationsPath, name), { recursive: true });
      }
    }
    migrate();
    db = new Database(databasePath);
    db.exec(`
      INSERT INTO Project(id,name,slug,repoPath,worktreeBasePath,updatedAt) VALUES('p','Project','project','/repo','/worktrees',1000);
      INSERT INTO Workspace(id,projectId,name,worktreePath,branchName,updatedAt) VALUES('ordinary','p','Ordinary','/worktrees/ordinary','ordinary',1000),('legacy','p','Legacy','/worktrees/legacy','legacy',1000);
      INSERT INTO WorkspaceAutoIteration(workspaceId,mode,status,config,progress,sessionId) VALUES('ordinary','STANDARD',NULL,NULL,NULL,NULL),('legacy','AUTO_ITERATION','RUNNING','{"testCommand":"pnpm test"}','{"currentIteration":2}','loop-session');
      INSERT INTO AgentSession(id,workspaceId,workflow,model,provider,providerSessionId,updatedAt) VALUES('main-session','ordinary','implement','sonnet','CLAUDE','main-history',1000),('loop-session','legacy','auto-iteration','sonnet','CLAUDE','loop-history',1000);
      INSERT INTO WorkspacePRMonitoring(workspaceId,enabled,recipientSessionId,bindingRevision,eventEpoch) VALUES('ordinary',true,'main-session',7,3);
    `);
    const settingsFixture = {
      id: 'settings',
      userId: 'migration-user',
      preferredIde: 'custom',
      customIdeCommand: 'editor {workspace}',
      playSoundOnComplete: 0,
      notificationSoundPath: '/sounds/complete.wav',
      workspaceOrder: '{"p":["legacy","ordinary"]}',
      cachedSlashCommands: '{"commands":["/review"]}',
      ratchetEnabled: 1,
      ratchetReplyToPrComments: 0,
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
      defaultSessionProvider: 'CODEX',
      defaultClaudeModel: 'opus',
      defaultCodexModel: 'gpt-5-codex',
      defaultClaudeReasoningEffort: 'high',
      defaultCodexReasoningEffort: 'medium',
      defaultWorkspacePermissions: 'YOLO',
      autoIterationPermissions: 'YOLO',
      reviewerSessionProvider: 'CLAUDE',
      reviewerClaudeModel: 'opus',
      reviewerCodexModel: 'gpt-5-codex',
      postReviewToGitHub: 0,
      voiceModeEnabled: 1,
      deepgramApiKeyEncrypted: 'encrypted-test-fixture',
      voiceTtsModel: 'flux-cliff-en',
      voiceTtsSpeed: 1.3,
      voiceUtteranceEndMs: 2500,
      voiceBargeInSustainedMs: 24,
      appearanceColorScheme: 'solarized',
      appearanceBackgroundColor: '#002b36',
      appearanceForegroundColor: '#93a1a1',
      appearanceFontScale: 125,
      appearanceFontSans: 'Inter',
      appearanceFontMono: 'Fira Code',
      createdAt: 1000,
      updatedAt: 2000,
    };
    const columns = Object.keys(settingsFixture);
    db.prepare(
      `INSERT INTO UserSettings(${columns.join(',')}) VALUES(${columns.map((column) => `@${column}`).join(',')})`
    ).run(settingsFixture);
    const workspaces = db.prepare('SELECT * FROM Workspace ORDER BY id').all();
    const sessions = db.prepare('SELECT * FROM AgentSession ORDER BY id').all();
    const monitoring = db.prepare('SELECT * FROM WorkspacePRMonitoring ORDER BY workspaceId').all();
    const settings = db
      .prepare<[], Record<string, unknown>>('SELECT * FROM UserSettings ORDER BY id')
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([column]) => column !== 'autoIterationPermissions')
        )
      );
    db.close();
    db = undefined;
    for (const name of readdirSync(source)) {
      if (name === migration) {
        cpSync(join(source, name), join(migrationsPath, name), { recursive: true });
      }
    }
    migrate();
    db = new Database(databasePath);
    expect(db.prepare('SELECT * FROM Workspace ORDER BY id').all()).toEqual(workspaces);
    expect(db.prepare('SELECT * FROM AgentSession ORDER BY id').all()).toEqual(sessions);
    expect(db.prepare('SELECT * FROM WorkspacePRMonitoring ORDER BY workspaceId').all()).toEqual(
      monitoring
    );
    expect(db.prepare('SELECT * FROM UserSettings ORDER BY id').all()).toEqual(settings);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='WorkspaceAutoIteration'").all()
    ).toEqual([]);
    expect(db.prepare('PRAGMA table_info(UserSettings)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'autoIterationPermissions' })])
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
