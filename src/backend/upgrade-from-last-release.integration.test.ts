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
 * Pinning a newer release is a script run, not an edit here; see
 * docs/npm-release-security.md.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  type SeedCoverage,
} from '@/backend/testing/upgrade/last-release';
import { DEFINITION_DIGEST, DEFINITION_TRIAGE } from '@/backend/testing/upgrade/seed-agent-rows';
import { seedTables } from '@/backend/testing/upgrade/seed-rows';
import { PROJECT_GITHUB, PROJECT_LINEAR } from '@/backend/testing/upgrade/seed-values';
import {
  WORKSPACE_CHILD,
  WORKSPACE_EVENT,
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

const MIGRATIONS_PATH = join(process.cwd(), 'prisma', 'migrations');
const lastRelease = readLastRelease();
const seededWorkspaces = z
  .array(z.object({ id: z.string(), status: z.string() }))
  .parse(seedTables.Workspace);
const seededSessions = z
  .array(z.object({ id: z.string(), workspaceId: z.string() }))
  .parse(seedTables.AgentSession);

let db: IntegrationDatabase;
let application: Application;
let dispose: typeof disposeApplication;
let trpc: ReturnType<typeof appRouter.createCaller>;
let seeded: SeedCoverage;
let pendingBeforeUpgrade: string[];
let backupsTaken: boolean;

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
      backupsTaken = existsSync(getPreMigrationBackupDirectory(databasePath));
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
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(() => {
    throw new Error('Unexpected provider creation');
  });
  // Liveness probes (signal 0) find no process; any real signal fails this check.
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
    }
    throw new Error(`Unexpected host signal ${String(signal)} to ${pid}`);
  });

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
  });

  it('reads each workspace, its sessions, terminals and closed sessions', async () => {
    for (const { id, status } of seededWorkspaces) {
      const detail = await trpc.workspace.get({ id });
      expect(detail.status).toBe(status);
      const sessions = await trpc.session.listSessions({ workspaceId: id });
      expect(sessions.map((session) => session.id).sort()).toEqual(
        seededSessions
          .filter((session) => session.workspaceId === id)
          .map((session) => session.id)
          .sort()
      );
      for (const session of sessions) {
        expect((await trpc.session.getSession({ id: session.id })).workspaceId).toBe(id);
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
    expect((await trpc.userSettings.get()).defaultSessionProvider).toBe('CLAUDE');
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
      expect(store.getByWorkspaceId(id) !== undefined, id).toBe(status !== 'ARCHIVED');
    }
  });

  it('runs the startup recovery steps over the seeded rows', async () => {
    const { reconciliationService, runScriptStateMachine, sessionLifecycleService } =
      application.services;
    await reconciliationService.cleanupOrphans();
    await sessionLifecycleService.recoverStaleRunningSessions();
    await reconciliationService.recoverStaleProvisioningWorkspaces();
    await runScriptStateMachine.recoverStaleStates();
  });

  it('reads periodic tasks and their executions', async () => {
    const tasks = await trpc.periodicTask.list({ projectId: PROJECT_GITHUB });
    expect(tasks).toHaveLength(5);
    await trpc.periodicTask.navigationSummary({ projectId: PROJECT_GITHUB });
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
    const triage = await trpc.automation.get({ projectId, agentId: DEFINITION_TRIAGE });
    expect(
      triage.configuredTriggers.map((trigger) => [trigger.activationState, trigger.capability])
    ).toEqual([
      ['ACTIVE', { status: 'SUPPORTED', reasonCode: 'SUPPORTED', explanation: expect.any(String) }],
    ]);
    expect(triage.configuredTriggers[0]?.sourceHealth?.state).toBe('READY');
    const digest = await trpc.automation.get({ projectId, agentId: DEFINITION_DIGEST });
    const digestTriggers = [...digest.configuredTriggers, ...digest.retainedTriggers];
    expect(digestTriggers.map((trigger) => trigger.activationState).sort()).toEqual([
      'PAUSED',
      'STARTING',
    ]);
    expect(digestTriggers.map((trigger) => trigger.capability.reasonCode)).not.toContain(
      'INVALID_STORED_DATA'
    );
    expect(
      digestTriggers.find((trigger) => trigger.pendingVerification)?.pendingVerification
    ).toMatchObject({ message: expect.stringContaining('abcd-efgh-jkmn') });

    const triageRuns = await trpc.automation.runs({ projectId, agentId: DEFINITION_TRIAGE });
    expect(triageRuns.items.map((run) => run.status).sort()).toEqual(
      [
        'CANCELLED',
        'COMPLETED',
        'FAILED',
        'PR_CREATED',
        'QUEUED',
        'RUNNING',
        'RUNNING',
        'RUNNING',
      ].sort()
    );
    expect(triageRuns.items.find((run) => run.status === 'CANCELLED')?.context.state).toBe(
      'EXPIRED'
    );
    const matched = await trpc.automation.evaluations({ projectId, agentId: DEFINITION_TRIAGE });
    expect(matched.items.map((evaluation) => evaluation.status)).toEqual(['MATCHED']);
    const others = await trpc.automation.evaluations({ projectId, agentId: DEFINITION_DIGEST });
    expect(others.items.map((evaluation) => evaluation.status).sort()).toEqual([
      'ERROR',
      'SKIPPED',
    ]);
    expect(await trpc.automation.navigationSummary({ projectId })).toMatchObject({
      failedCount: 0,
    });
    const origin = await trpc.automation.workspaceOrigin({
      projectId,
      workspaceId: WORKSPACE_EVENT,
    });
    expect(origin?.origin.workspaceState).toBe('LIVE');
  });

  it('exports every table through the backup schema, which parses stored JSON as it goes', async () => {
    const exported = await trpc.admin.exportData();
    expect(exported.data.projects).toHaveLength(2);
    expect(exported.data.workspaces).toHaveLength(seededWorkspaces.length);
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
