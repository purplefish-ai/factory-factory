/**
 * Starts the current build on a database the last published release left behind.
 *
 * Users upgrade the package in place and the migrator is one-way, so this is the
 * path every user takes, and the only check that runs real rows from the previous
 * release through the migrations and the code that reads them. The database is
 * created by applying exactly the migrations that release shipped
 * (`fixtures/upgrade/last-release.json`), loading the seed
 * (`fixtures/upgrade/last-release-seed.sql`: a row in every table, every enum
 * value in use), and then running the same migration entry point `ff` uses. The
 * real application graph then reads what the board, the sidebar and the
 * automations page read.
 *
 * A failure here means the code broke upgrades from the pinned release: fix the
 * code. Do not edit the seed or the expectations below to make it pass; the seed
 * changes only when re-pinning or adding rows for a new table or value, with
 * `scripts/update-last-release-migrations.mjs` (docs/npm-release-security.md).
 * The expectations are what the application derives from the seeded rows; a
 * migration that changes one of them changes what users see after upgrading.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Application, disposeApplication } from '@/backend/app-context';
import { inspectMigrations } from '@/backend/migrate';
import {
  getPreMigrationBackupDirectory,
  runMigrationsWithBackup,
} from '@/backend/migrate-with-backup';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import {
  loadSeed,
  measureSeedCoverage,
  migrateToLastRelease,
  readLastRelease,
  REPOSITORY_MIGRATIONS as MIGRATIONS_PATH,
  type SeedCoverage,
} from '@/backend/testing/upgrade/last-release';
import {
  DEFINITION_DIGEST,
  DEFINITION_LEGACY,
  DEFINITION_TRIAGE,
} from '@/backend/testing/upgrade/seed-agent-rows';
import { seedTables } from '@/backend/testing/upgrade/seed-rows';
import { PROJECT_GITHUB, PROJECT_LINEAR, UNUSED_PID } from '@/backend/testing/upgrade/seed-values';
import {
  SESSION_CODEX_RUNNING,
  WORKSPACE_CHILD,
  WORKSPACE_EVENT,
  WORKSPACE_ISSUE,
  WORKSPACE_MANUAL,
} from '@/backend/testing/upgrade/seed-workspace-rows';
import type { appRouter } from '@/backend/trpc';
import { QuestionResponseSchema } from '@/shared/acp-protocol/protocol/question-response';
import { agentValidatedIntentSchema } from '@/shared/agent-management';
import { agentSpecificationSchema } from '@/shared/agent-proposal';
import { storedAgentRunContextSchema } from '@/shared/agent-run-context';
import {
  agentActivationBoundarySchema,
  agentClassifierIdentitySchema,
  agentEvaluationFailureSnapshotSchema,
  agentEvaluationSnapshotSchema,
  agentEventPayloadSchema,
  agentPendingActivationSchema,
  agentRunResultSchema,
  agentSourceCursorSchema,
  agentSourceHealthSchema,
} from '@/shared/agent-runtime';
import { agentSourcePageEvidenceSchema } from '@/shared/agent-source-state';
import { initialDeliveryEvidenceSchema } from '@/shared/event-agent-delivery';
import {
  eventAgentExecutionSchema,
  eventWorkspaceIdentitySchema,
} from '@/shared/event-agent-launch';
import { eventLaunchPreparationSchema } from '@/shared/event-agent-preparation';
import {
  agentDefinitionInputSchema,
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import { IssueTrackerConfigSchema } from '@/shared/schemas/issue-tracker-config.schema';
import {
  prMonitoringEventPayloadSchema,
  prStoredObservationSchema,
} from '@/shared/schemas/pr-event.schema';
import { sessionLaunchSettingsSchema } from '@/shared/session-launch';

const lastRelease = readLastRelease();
const seededWorkspaces = z
  .array(z.object({ id: z.string(), status: z.string() }))
  .parse(seedTables.Workspace);
const seededSessions = z
  .array(z.object({ id: z.string(), workspaceId: z.string() }))
  .parse(seedTables.AgentSession);

/** What the application derives for each seeded workspace, reviewed against the derivation code. */
interface DerivedWorkspace {
  kanbanColumn: 'WORKING' | 'WAITING' | null;
  sidebarStatus: { activityState: string; ciState: string };
  flowPhase: string;
  ciObservation: string;
  statusReason: string;
  ratchetButtonAnimated: boolean;
  /** The pull request summary the board and snapshot carry; every active PR collapses to OPEN. */
  prState: string;
  prCiStatus: string;
  ratchetState: string;
}
const DERIVED_WORKSPACES: Record<string, DerivedWorkspace> = {
  // READY, a monitored OPEN PR with passing CI and an update queued for the main session.
  'seed-workspace-manual': {
    kanbanColumn: 'WAITING',
    sidebarStatus: { activityState: 'IDLE', ciState: 'PASSING' },
    flowPhase: 'READY',
    ciObservation: 'CHECKS_PASSED',
    statusReason: 'PR_UPDATE_QUEUED',
    ratchetButtonAnimated: false,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    ratchetState: 'READY',
  },
  // READY, a monitored DRAFT PR with pending CI, monitoring paused after a failed session.
  'seed-workspace-resume': {
    kanbanColumn: 'WAITING',
    sidebarStatus: { activityState: 'IDLE', ciState: 'RUNNING' },
    flowPhase: 'CI_WAIT',
    ciObservation: 'CHECKS_PENDING',
    statusReason: 'PR_UPDATES_PAUSED',
    ratchetButtonAnimated: true,
    prState: 'OPEN',
    prCiStatus: 'PENDING',
    ratchetState: 'CI_RUNNING',
  },
  // PROVISIONING, with a PR attached that GitHub has not been asked about yet.
  'seed-workspace-issue': {
    kanbanColumn: 'WORKING',
    sidebarStatus: { activityState: 'IDLE', ciState: 'UNKNOWN' },
    flowPhase: 'CI_WAIT',
    ciObservation: 'NOT_FETCHED',
    statusReason: 'SETTING_UP',
    ratchetButtonAnimated: false,
    prState: 'OPEN',
    prCiStatus: 'UNKNOWN',
    ratchetState: 'IDLE',
  },
  // FAILED setup; monitoring is off, so a failing, conflicted PR still reads as READY for a person.
  'seed-workspace-linear': {
    kanbanColumn: 'WAITING',
    sidebarStatus: { activityState: 'IDLE', ciState: 'FAILING' },
    flowPhase: 'READY',
    ciObservation: 'CHECKS_FAILED',
    statusReason: 'SETUP_FAILED',
    ratchetButtonAnimated: false,
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    ratchetState: 'IDLE',
  },
  // READY, an APPROVED PR with passing CI.
  'seed-workspace-event': {
    kanbanColumn: 'WAITING',
    sidebarStatus: { activityState: 'IDLE', ciState: 'PASSING' },
    flowPhase: 'READY',
    ciObservation: 'CHECKS_PASSED',
    statusReason: 'READY_TO_MERGE',
    ratchetButtonAnimated: false,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    ratchetState: 'IDLE',
  },
  // NEW, no PR.
  'seed-workspace-periodic': {
    kanbanColumn: 'WORKING',
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    statusReason: 'SETTING_UP',
    ratchetButtonAnimated: false,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    ratchetState: 'IDLE',
  },
  // ARCHIVING and ARCHIVED leave the board.
  'seed-workspace-child': {
    kanbanColumn: null,
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    statusReason: 'ARCHIVING',
    ratchetButtonAnimated: false,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    ratchetState: 'IDLE',
  },
  'seed-workspace-archived': {
    kanbanColumn: null,
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    statusReason: 'ARCHIVED',
    ratchetButtonAnimated: false,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    ratchetState: 'IDLE',
  },
};

/**
 * Each seeded session as the workspace read summarises it: the stored status is
 * kept, but no runtime is attached after a restart, so none is working. A stale
 * RUNNING row must not read as busy.
 */
const DERIVED_SESSIONS: Record<
  string,
  { provider: string; persistedStatus: string; model: string; codexAccountId: string | null }
> = {
  'seed-session-claude-idle': {
    provider: 'CLAUDE',
    persistedStatus: 'IDLE',
    model: 'sonnet',
    codexAccountId: null,
  },
  'seed-session-codex-running': {
    provider: 'CODEX',
    persistedStatus: 'RUNNING',
    model: 'gpt-5.4',
    codexAccountId: 'seed-codex-managed',
  },
  'seed-session-claude-paused': {
    provider: 'CLAUDE',
    persistedStatus: 'PAUSED',
    model: 'opus',
    codexAccountId: null,
  },
  'seed-session-codex-completed': {
    provider: 'CODEX',
    persistedStatus: 'COMPLETED',
    model: 'gpt-5.4',
    codexAccountId: 'codex-native-default',
  },
  'seed-session-claude-failed': {
    provider: 'CLAUDE',
    persistedStatus: 'FAILED',
    model: 'sonnet',
    codexAccountId: null,
  },
  'seed-session-event': {
    provider: 'CLAUDE',
    persistedStatus: 'IDLE',
    model: 'sonnet',
    codexAccountId: null,
  },
};

/** Each seeded event-agent run as the history read reports it. */
const DERIVED_RUNS: Record<
  string,
  {
    status: string;
    launchPhase: string;
    delivery: string | null;
    workspaceState: string;
    reasonCode: string | null;
    context: string;
  }
> = {
  'seed-run-queued': {
    status: 'QUEUED',
    launchPhase: 'RESERVED',
    delivery: null,
    workspaceState: 'UNRESERVED',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-provisioning': {
    status: 'RUNNING',
    launchPhase: 'PROVISIONING',
    delivery: null,
    workspaceState: 'RESERVED',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-ready': {
    status: 'RUNNING',
    launchPhase: 'READY',
    delivery: 'PENDING',
    workspaceState: 'RESERVED',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-dispatching': {
    status: 'RUNNING',
    launchPhase: 'DISPATCHING',
    delivery: 'SENDING',
    workspaceState: 'RESERVED',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-active': {
    status: 'RUNNING',
    launchPhase: 'ACTIVE',
    delivery: 'ACCEPTED',
    workspaceState: 'LIVE',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-attention': {
    status: 'FAILED',
    launchPhase: 'NEEDS_ATTENTION',
    delivery: 'AMBIGUOUS',
    workspaceState: 'RESERVED',
    reasonCode: 'DELIVERY_AMBIGUOUS',
    context: 'RETAINED',
  },
  'seed-run-completed': {
    status: 'COMPLETED',
    launchPhase: 'FINISHED',
    delivery: 'FINISHED',
    workspaceState: 'RESERVED',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-pr-created': {
    status: 'PR_CREATED',
    launchPhase: 'FINISHED',
    delivery: null,
    workspaceState: 'RESERVED',
    reasonCode: null,
    context: 'RETAINED',
  },
  'seed-run-cancelled': {
    status: 'CANCELLED',
    launchPhase: 'FINISHED',
    delivery: null,
    workspaceState: 'RESERVED',
    reasonCode: 'SOURCE_RESET',
    context: 'EXPIRED',
  },
};

/** Trigger id to [activation state, capability reason, source health, paused reason]. */
const DERIVED_TRIGGERS: Record<string, [string, string, string | null, string | null]> = {
  'seed-trigger-github': ['ACTIVE', 'SUPPORTED', 'READY', null],
  'seed-trigger-slack': ['STARTING', 'SLACK_INTAKE_UNAVAILABLE', 'CATCHING_UP', null],
  // Schedules run as periodic tasks, so an event automation reports them unsupported.
  'seed-trigger-schedule': ['PAUSED', 'UNSUPPORTED_SCHEDULE', null, 'ACTIVATION_EXPIRED'],
  // Triggers saved before membership was recorded have no known configuration.
  'seed-trigger-legacy': ['PAUSED', 'UNKNOWN_MEMBERSHIP', null, null],
  'seed-trigger-paused-source-error': ['PAUSED', 'UNKNOWN_MEMBERSHIP', 'READY', 'SOURCE_ERROR'],
  'seed-trigger-paused-source-recovery-required': [
    'PAUSED',
    'UNKNOWN_MEMBERSHIP',
    'READY',
    'SOURCE_RECOVERY_REQUIRED',
  ],
};

let db: IntegrationDatabase;
let application: Application;
let dispose: typeof disposeApplication;
let trpc: ReturnType<typeof appRouter.createCaller>;
let seeded: SeedCoverage;
let pendingBeforeUpgrade: string[];
let backupsTaken: boolean;
let factory: typeof import('@/backend/services/session/service/acp/acp-client-factory');
/** Every signal the code under test tried to send, whatever the guard answered. */
const signalAttempts: Array<{ pid: number; signal: string | number | undefined }> = [];

/**
 * Nothing in this check may start a provider or signal a process. The global
 * `afterEach` in `setup.ts` restores every spy, so the guards are installed
 * before each test, not once in `beforeAll`.
 */
function installGuards(): void {
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(() => {
    throw new Error('Unexpected provider creation');
  });
  // Liveness probes (signal 0) find no process; any real signal is recorded and refused.
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    signalAttempts.push({ pid, signal });
    if (signal === 0) {
      throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
    }
    throw new Error(`Unexpected host signal ${String(signal)} to ${pid}`);
  });
}

function expectGuardsActive(): void {
  expect(vi.isMockFunction(process.kill)).toBe(true);
  expect(vi.isMockFunction(factory.AcpClientFactory.prototype.createClient)).toBe(true);
}

beforeEach(() => {
  signalAttempts.length = 0;
  installGuards();
});

afterEach(() => {
  expectGuardsActive();
  expect(signalAttempts.filter(({ signal }) => signal !== 0)).toEqual([]);
});

beforeAll(async () => {
  db = await createIntegrationDatabase({
    prepareDatabase: async (databasePath) => {
      migrateToLastRelease(databasePath, lastRelease);
      loadSeed(databasePath);
      seeded = measureSeedCoverage(databasePath, lastRelease);
      pendingBeforeUpgrade = inspectMigrations({
        databasePath,
        migrationsPath: MIGRATIONS_PATH,
      }).pendingMigrations;
      // The entry point the CLI and the desktop utility process use.
      await runMigrationsWithBackup({
        databasePath,
        migrationsPath: MIGRATIONS_PATH,
        log: () => {
          // Silent in tests.
        },
      });
      const backups = getPreMigrationBackupDirectory(databasePath);
      backupsTaken =
        existsSync(backups) && readdirSync(backups).some((name) => name.endsWith('.db'));
    },
  });
  vi.stubEnv('BASE_DIR', join(db.tempDir, 'application'));
  // Nothing in this check may start a provider, signal a process or read a real Codex profile.
  vi.stubEnv('CODEX_HOME', join(db.tempDir, 'codex-home'));
  vi.stubEnv('CODEX_SESSIONS_DIR', join(db.tempDir, 'codex-sessions'));

  const runScript = await vi.importActual<typeof import('@/backend/services/run-script')>(
    '@/backend/services/run-script'
  );
  vi.spyOn(runScript.RunScriptService.prototype, 'registerShutdownHandlers').mockImplementation(
    () => undefined
  );
  factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  installGuards();

  const app =
    await vi.importActual<typeof import('@/backend/app-context')>('@/backend/app-context');
  dispose = app.disposeApplication;
  const dependencies = app.createDefaultApplicationDependencies();
  vi.spyOn(dependencies.lifecycle.eventCollector, 'start').mockImplementation(() => undefined);
  application = app.createApplication(dependencies);
  const { appRouter: router } =
    await vi.importActual<typeof import('@/backend/trpc')>('@/backend/trpc');
  trpc = router.createCaller({ appContext: application });
}, 60_000);

afterAll(async () => {
  if (factory) {
    installGuards();
  }
  try {
    if (application) {
      await dispose(application);
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (db) {
      await destroyIntegrationDatabase(db);
    }
  }
});

/** Parse every non-null stored value, and fail if the seed has nothing to parse. */
function parseStored(label: string, values: unknown[], schema: z.ZodType) {
  const stored = values.filter((value) => value !== null && value !== undefined);
  expect(stored.length, `${label} has no seeded value`).toBeGreaterThan(0);
  for (const value of stored) {
    const result = schema.safeParse(value);
    expect(result.success, `${label}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
  }
}

describe('upgrading from the last published release', () => {
  it('runs on temporary directories only, never on the data directory of a real install', () => {
    const { configService } = application.services;
    expect(configService.getDatabasePath()).toBe(db.databasePath);
    expect(configService.getBaseDir()).toBe(join(db.tempDir, 'application'));
  });

  it('starts from a database that holds a row in every table and every enum value', () => {
    expect(seeded.emptyTables).toEqual([]);
    expect(seeded.missingEnumValues).toEqual([]);
  });

  it('applies every migration written since that release, after a backup when any was pending', () => {
    const after = inspectMigrations({
      databasePath: db.databasePath,
      migrationsPath: MIGRATIONS_PATH,
    });
    expect(after.pendingMigrations).toEqual([]);
    expect(after.unknownAppliedMigrations).toEqual([]);
    expect(backupsTaken).toBe(pendingBeforeUpgrade.length > 0);
  });

  it('loads the board: every workspace still in use, with its pull requests', async () => {
    const lists = await Promise.all(
      [PROJECT_GITHUB, PROJECT_LINEAR].map((projectId) =>
        trpc.workspace.listForProject({ projectId })
      )
    );
    const listed = lists.flatMap((list) => list.workspaces.map((workspace) => workspace.id));
    expect(listed.sort()).toEqual(
      seededWorkspaces
        .filter((workspace) => !['ARCHIVING', 'ARCHIVED'].includes(workspace.status))
        .map(({ id }) => id)
        .sort()
    );
    const manual = lists[0]?.workspaces.find(({ id }) => id === WORKSPACE_MANUAL);
    expect(manual?.prs).toHaveLength(2);
    for (const workspace of lists.flatMap((list) => list.workspaces)) {
      const expected = DERIVED_WORKSPACES[workspace.id];
      expect(workspace, workspace.id).toMatchObject({
        kanbanColumn: expected?.kanbanColumn,
        sidebarStatus: expected?.sidebarStatus,
        flowPhase: expected?.flowPhase,
        ciObservation: expected?.ciObservation,
        statusReason: { code: expected?.statusReason },
        ratchetButtonAnimated: expected?.ratchetButtonAnimated,
        prState: expected?.prState,
        prCiStatus: expected?.prCiStatus,
        ratchetState: expected?.ratchetState,
        isWorking: false,
      });
    }
  });

  it('reads each workspace, its sessions, terminals and closed sessions', async () => {
    for (const { id, status } of seededWorkspaces) {
      const detail = await trpc.workspace.get({ id });
      expect(detail.status).toBe(status);
      const expected = DERIVED_WORKSPACES[id];
      expect(detail, id).toMatchObject({
        kanbanColumn: expected?.kanbanColumn,
        sidebarStatus: expected?.sidebarStatus,
        flowPhase: expected?.flowPhase,
        ciObservation: expected?.ciObservation,
        statusReason: { code: expected?.statusReason },
        ratchetButtonAnimated: expected?.ratchetButtonAnimated,
        pendingRequestType: null,
      });
      for (const summary of detail.sessionSummaries) {
        expect(summary, summary.sessionId).toMatchObject({
          ...DERIVED_SESSIONS[summary.sessionId],
          runtimePhase: 'idle',
          processState: 'stopped',
          activity: 'IDLE',
          pendingRequestType: null,
        });
      }
      const sessions = await trpc.session.listSessions({ workspaceId: id });
      expect(sessions.map((session) => session.id).sort()).toEqual(
        seededSessions
          .filter((session) => session.workspaceId === id)
          .map((session) => session.id)
          .sort()
      );
      for (const session of sessions) {
        expect((await trpc.session.getSession({ id: session.id })).workspaceId).toBe(id);
        expect(session.isWorking, session.id).toBe(false);
        expect(session, session.id).toMatchObject({
          provider: DERIVED_SESSIONS[session.id]?.provider,
          status: DERIVED_SESSIONS[session.id]?.persistedStatus,
        });
      }
      await trpc.session.listTerminalSessions({ workspaceId: id });
      await trpc.closedSessions.list({ workspaceId: id });
      await trpc.workspace.getInitStatus({ id });
    }
  });

  it('reads the projects, settings, workspace order and relationships the sidebar needs', async () => {
    const projects = await trpc.project.list({ includeBoardCounts: true });
    expect(projects.map((project) => project.id).sort()).toEqual([PROJECT_GITHUB, PROJECT_LINEAR]);
    const linear = projects.find((project) => project.id === PROJECT_LINEAR);
    expect(linear?.issueTrackerConfig?.linear?.hasApiKey).toBe(true);
    for (const { id } of projects) {
      await trpc.project.getById({ id });
    }
    expect(await trpc.userSettings.get()).toMatchObject({
      preferredIde: 'vscode',
      defaultSessionProvider: 'CODEX',
      defaultClaudeModel: 'opus',
      defaultWorkspacePermissions: 'RELAXED',
      automationPermissions: 'YOLO',
      reviewerSessionProvider: 'CLAUDE',
      voiceModeEnabled: true,
      voiceTtsSpeed: 1.25,
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
    });
    expect(await trpc.userSettings.getWorkspaceOrder({ projectId: PROJECT_GITHUB })).toEqual([
      'seed-workspace-manual',
      'seed-workspace-resume',
      'seed-workspace-issue',
    ]);
    const children = await trpc.workspace.listChildren({ parentWorkspaceId: WORKSPACE_MANUAL });
    expect(children.map((child) => child.id)).toEqual([WORKSPACE_CHILD]);
    expect((await trpc.workspace.getParent({ childWorkspaceId: WORKSPACE_CHILD }))?.id).toBe(
      WORKSPACE_MANUAL
    );
    await trpc.workspace.unreadMailCounts({ projectId: PROJECT_GITHUB });
    const mail = await trpc.workspace.listMail({
      workspaceId: WORKSPACE_MANUAL,
      includeSuperseded: true,
    });
    expect(mail.items.length).toBeGreaterThan(0);
  });

  it('seeds the snapshot store from every workspace without skipping one', async () => {
    const result = await application.lifecycle.snapshotReconciliation.reconcile();
    expect(result.workspacesSkipped).toBe(0);
    expect(result.workspacesReconciled).toBe(result.workspacesScanned);
    const store = application.services.workspaceSnapshotStore;
    for (const { id, status } of seededWorkspaces) {
      const entry = store.getByWorkspaceId(id);
      expect(entry !== undefined, id).toBe(status !== 'ARCHIVED');
      const expected = DERIVED_WORKSPACES[id];
      if (entry && expected) {
        expect(entry, id).toMatchObject({
          status,
          kanbanColumn: expected.kanbanColumn,
          sidebarStatus: expected.sidebarStatus,
          flowPhase: expected.flowPhase,
          ciObservation: expected.ciObservation,
          statusReason: { code: expected.statusReason },
          prState: expected.prState,
          prCiStatus: expected.prCiStatus,
          ratchetState: expected.ratchetState,
          isWorking: false,
        });
        for (const summary of entry.sessionSummaries) {
          expect(summary, summary.sessionId).toMatchObject({
            provider: DERIVED_SESSIONS[summary.sessionId]?.provider,
            persistedStatus: DERIVED_SESSIONS[summary.sessionId]?.persistedStatus,
            activity: 'IDLE',
          });
        }
      }
    }
  });

  it('runs the startup recovery steps and leaves the seeded stale rows settled', async () => {
    const { prisma } = db;
    const { reconciliationService, runScriptStateMachine, sessionLifecycleService } =
      application.services;
    // Provisioning recovery asks git about the project's repository, so point the
    // seeded project at a real, empty one inside the temp directory.
    const repoPath = join(db.tempDir, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    await prisma.project.update({
      where: { id: PROJECT_GITHUB },
      data: { repoPath, worktreeBasePath: join(db.tempDir, 'worktrees') },
    });
    expect(
      (await prisma.agentSession.findUniqueOrThrow({ where: { id: SESSION_CODEX_RUNNING } })).status
    ).toBe('RUNNING');
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: WORKSPACE_ISSUE } })).status
    ).toBe('PROVISIONING');
    expectGuardsActive();
    await reconciliationService.cleanupOrphans();
    await sessionLifecycleService.recoverStaleRunningSessions();
    await reconciliationService.recoverStaleProvisioningWorkspaces();
    await runScriptStateMachine.recoverStaleStates();
    expect(await prisma.agentSession.findMany({ where: { status: 'RUNNING' } })).toEqual([]);
    expect(
      await prisma.workspaceRunScript.findMany({
        where: { status: { in: ['STARTING', 'STOPPING'] } },
      })
    ).toEqual([]);
    expect(
      await prisma.workspace.findUniqueOrThrow({ where: { id: WORKSPACE_ISSUE } })
    ).toMatchObject({
      status: 'FAILED',
      initErrorMessage: expect.stringContaining('Provisioning timed out'),
    });
    // The only process question recovery asks is a liveness probe of the seeded pid.
    expect(signalAttempts).toEqual([{ pid: UNUSED_PID, signal: 0 }]);
  });

  it('reads periodic tasks and their executions', async () => {
    const tasks = await trpc.periodicTask.list({ projectId: PROJECT_GITHUB });
    expect(tasks).toHaveLength(5);
    // The latest finished execution of the daily task is the failed one.
    expect(await trpc.periodicTask.navigationSummary({ projectId: PROJECT_GITHUB })).toEqual({
      totalCount: 5,
      failedCount: 1,
    });
    const executions = await Promise.all(
      tasks.map(async ({ id }) => {
        await trpc.periodicTask.get({ id });
        await trpc.periodicTask.listExecutionsByPeriodicTaskId({ periodicTaskId: id });
        return trpc.periodicTask.listExecutions({ periodicTaskId: id });
      })
    );
    expect(executions.flat()).toHaveLength(5);
  });

  it('reads event automations: triggers in each state, runs, evaluations and origins', async () => {
    const projectId = PROJECT_GITHUB;
    const list = await trpc.automation.list({ projectId });
    expect(list.items).toHaveLength(3);
    const triggers = Object.fromEntries(
      (
        await Promise.all(
          [DEFINITION_TRIAGE, DEFINITION_DIGEST, DEFINITION_LEGACY].map((agentId) =>
            trpc.automation.get({ projectId, agentId })
          )
        )
      ).flatMap((agent) =>
        [...agent.configuredTriggers, ...agent.retainedTriggers].map((trigger) => [
          trigger.id,
          [
            trigger.activationState,
            trigger.capability.reasonCode,
            trigger.sourceHealth?.state ?? null,
            trigger.pausedReasonCode,
          ],
        ])
      )
    );
    expect(triggers).toEqual(DERIVED_TRIGGERS);
    const digest = await trpc.automation.get({ projectId, agentId: DEFINITION_DIGEST });
    expect(
      [...digest.configuredTriggers, ...digest.retainedTriggers].find(
        (trigger) => trigger.pendingVerification
      )?.pendingVerification
    ).toMatchObject({ message: expect.stringContaining('abcd-efgh-jkmn') });

    const runs = (
      await Promise.all(
        [DEFINITION_TRIAGE, DEFINITION_DIGEST].map((agentId) =>
          trpc.automation.runs({ projectId, agentId })
        )
      )
    ).flatMap((page) => page.items);
    expect(
      Object.fromEntries(
        runs.map((run) => [
          run.id,
          {
            status: run.status,
            launchPhase: run.launchPhase,
            delivery: run.delivery?.state ?? null,
            workspaceState: run.workspaceState,
            reasonCode: run.reasonCode,
            context: run.context.state,
          },
        ])
      )
    ).toEqual(DERIVED_RUNS);
    const evaluations = await Promise.all(
      [DEFINITION_TRIAGE, DEFINITION_DIGEST].map((agentId) =>
        trpc.automation.evaluations({ projectId, agentId })
      )
    );
    expect(
      evaluations.flatMap((page) =>
        page.items.map((item) => [item.id, item.status, item.reasonCode, item.runId])
      )
    ).toEqual([
      ['seed-evaluation-matched', 'MATCHED', 'MATCHED', 'seed-run-queued'],
      ['seed-evaluation-skipped', 'SKIPPED', 'NOT_MATCHED', null],
      ['seed-evaluation-error', 'ERROR', 'INVALID_STORED_DATA', null],
    ]);
    // The latest finished run of each agent decides this count, and that is a cancellation.
    expect(await trpc.automation.navigationSummary({ projectId })).toEqual({
      totalCount: 3,
      failedCount: 0,
    });
    const origin = await trpc.automation.workspaceOrigin({
      projectId,
      workspaceId: WORKSPACE_EVENT,
    });
    expect(origin?.origin.workspaceState).toBe('LIVE');
  });

  it('exports the seeded rows through the backup schema, which parses stored JSON as it goes', async () => {
    const exported = await trpc.admin.exportData();
    expect(exported.data.projects).toHaveLength(seedTables.Project?.length ?? 0);
    expect(exported.data.workspaces).toHaveLength(seededWorkspaces.length);
    expect(exported.data.agentSessions).toHaveLength(seededSessions.length);
    expect(exported.data.terminalSessions).toHaveLength(seedTables.TerminalSession?.length ?? 0);
  });

  it('parses the stored JSON no read above touches with the schemas the code declares', async () => {
    const { prisma } = db;
    const triggers = await prisma.agentTrigger.findMany();
    parseStored(
      'AgentTrigger',
      triggers.map(
        ({ type, connectionId, description, filterInstructions, isEnabled, config }) => ({
          type,
          connectionId,
          description,
          filterInstructions,
          isEnabled,
          config,
        })
      ),
      agentTriggerInputSchema
    );
    parseStored(
      'AgentTrigger.activationBoundary',
      triggers.map((row) => row.activationBoundary),
      agentActivationBoundarySchema
    );
    parseStored(
      'AgentTrigger.pendingActivation',
      triggers.map((row) => row.pendingActivation),
      agentPendingActivationSchema
    );
    const definitions = await prisma.agentDefinition.findMany();
    parseStored(
      'AgentDefinition.executionConfig',
      definitions.map((row) => row.executionConfig),
      agentExecutionConfigSchema
    );
    parseStored(
      'AgentDefinition.validatedIntent',
      definitions.map((row) => row.validatedIntent),
      agentValidatedIntentSchema
    );
    const proposals = await prisma.agentProposal.findMany();
    parseStored(
      'AgentProposal.specification',
      proposals.map((row) => row.specification),
      agentSpecificationSchema
    );
    parseStored(
      'AgentProposal.sourceNames',
      proposals.map((row) => row.sourceNames),
      z.record(z.string(), z.string())
    );
    const runs = await prisma.agentRun.findMany();
    parseStored(
      'AgentRun context',
      runs.map((run) => ({
        contextExpiredAt: run.contextExpiredAt?.toISOString() ?? null,
        definitionSnapshot: run.definitionSnapshot,
        triggerSnapshot: run.triggerSnapshot,
        input: run.input,
      })),
      storedAgentRunContextSchema
    );
    parseStored(
      'AgentRun.definitionSnapshot of a retained run',
      runs.filter((run) => run.contextExpiredAt === null).map((run) => run.definitionSnapshot),
      agentDefinitionInputSchema
    );
    parseStored(
      'AgentRun.effectiveExecution',
      runs.map((row) => row.effectiveExecution),
      eventAgentExecutionSchema
    );
    parseStored(
      'AgentRun.launchPreparation',
      runs.map((row) => row.launchPreparation),
      eventLaunchPreparationSchema
    );
    parseStored(
      'AgentRun.result',
      runs.map((row) => row.result),
      agentRunResultSchema
    );
    const states = await prisma.agentSourceState.findMany();
    parseStored(
      'AgentSourceState.cursor',
      states.map((row) => row.cursor),
      agentSourceCursorSchema
    );
    parseStored(
      'AgentSourceState.health',
      states.map((row) => row.health),
      agentSourceHealthSchema
    );
    parseStored(
      'AgentSourcePage.evidence',
      (await prisma.agentSourcePage.findMany()).map((row) => row.evidence),
      agentSourcePageEvidenceSchema
    );
    parseStored(
      'AgentEvent.payload',
      (await prisma.agentEvent.findMany()).map((row) => row.payload),
      agentEventPayloadSchema
    );
    const evaluations = await prisma.agentEvaluation.findMany();
    parseStored(
      'AgentEvaluation.configurationSnapshot',
      evaluations.map((row) => row.configurationSnapshot),
      z.union([agentEvaluationSnapshotSchema, agentEvaluationFailureSnapshotSchema])
    );
    parseStored(
      'AgentEvaluation.classifier',
      evaluations.map((row) => row.classifier),
      agentClassifierIdentitySchema
    );
    parseStored(
      'AgentInitialDelivery.evidence',
      (await prisma.agentInitialDelivery.findMany()).map((row) => row.evidence),
      initialDeliveryEvidenceSchema
    );
    parseStored(
      'AgentSessionLaunchOrigin.execution',
      (await prisma.agentSessionLaunchOrigin.findMany()).map((row) => row.execution),
      eventAgentExecutionSchema
    );
    const workspaces = await prisma.workspace.findMany();
    parseStored(
      'Workspace.creationMetadata of an event workspace',
      workspaces
        .filter((workspace) => workspace.creationSource === 'EVENT_AGENT')
        .map((workspace) => workspace.creationMetadata),
      eventWorkspaceIdentitySchema
    );
    parseStored(
      'WorkspacePR.observation',
      (await prisma.workspacePR.findMany()).map((row) => row.observation),
      prStoredObservationSchema
    );
    parseStored(
      'WorkspacePREvent.payload',
      (await prisma.workspacePREvent.findMany()).map((row) => row.payload),
      prMonitoringEventPayloadSchema
    );
    parseStored(
      'SessionQuestionResponse.summary',
      (await prisma.sessionQuestionResponse.findMany()).map((row) => row.summary),
      QuestionResponseSchema
    );
    parseStored(
      'Project.issueTrackerConfig',
      (await prisma.project.findMany()).map((row) => row.issueTrackerConfig),
      IssueTrackerConfigSchema
    );
    parseStored(
      'AgentSession.providerMetadata.launchSettings',
      (await prisma.agentSession.findMany()).flatMap((session) => {
        const metadata = z.record(z.string(), z.unknown()).safeParse(session.providerMetadata);
        return metadata.success ? [metadata.data.launchSettings] : [];
      }),
      sessionLaunchSettingsSchema.extend({ applied: z.boolean() })
    );
  });

  it('reads every row of every table through Prisma, which rejects unknown enum values', async () => {
    const { Prisma } =
      await vi.importActual<typeof import('@prisma-gen/client')>('@prisma-gen/client');
    const delegates = db.prisma as unknown as Record<string, { findMany(): Promise<unknown[]> }>;
    const models = Object.values(Prisma.ModelName);
    expect(models.length).toBeGreaterThanOrEqual(Object.keys(seedTables).length);
    for (const name of models) {
      const delegate = delegates[`${name.charAt(0).toLowerCase()}${name.slice(1)}`];
      expect(delegate, name).toBeDefined();
      await delegate?.findMany();
    }
  });
});
