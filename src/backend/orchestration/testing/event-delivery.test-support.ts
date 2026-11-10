import { vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';
import type { IntegrationDatabase } from '@/backend/testing/integration-db';
import { agentEvaluationSnapshotSchema, agentEventPayloadSchema } from '@/shared/agent-runtime';
import type { EventAgentExecution } from '@/shared/event-agent-launch';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Await an event without polling, but surface failed or silent fixture startup. */
export async function waitForEventFixture<T>(
  ready: Promise<T>,
  label: string,
  options: { settled?: Promise<unknown>; timeoutMs?: number } = {}
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      options.timeoutMs ?? 2000
    );
  });
  const settled = options.settled?.then(() => {
    throw new Error(`Launch settled before ${label}`);
  });
  try {
    return await Promise.race(
      settled !== undefined ? [ready, settled, deadline] : [ready, deadline]
    );
  } finally {
    clearTimeout(timer);
  }
}
const releases = new Set<() => void>();
const tasks = new Set<Promise<void>>();
export function releaseEventBoundaries() {
  for (const release of releases) {
    release();
  }
  releases.clear();
}
export async function drainEventFixtureTasks() {
  while (tasks.size > 0) {
    await Promise.allSettled([...tasks]);
  }
}
export function trackEventFixtureTask(task: Promise<void>) {
  tasks.add(task);
  void task.then(
    () => tasks.delete(task),
    () => tasks.delete(task)
  );
  return task;
}
export function boundary() {
  const entered = deferred<void>();
  const released = deferred<void>();
  const release = () => released.resolve();
  releases.add(release);
  return {
    entered: entered.promise,
    release,
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

/** Shared source identity and execution settings for both admission fixture boundaries. */
async function createEventSeed(
  db: IntegrationDatabase,
  provider: 'CLAUDE' | 'CODEX',
  admission: 'source' | 'persisted'
) {
  const owner = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  const workspace = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  );
  const session = await vi.importActual<typeof import('@/backend/services/session')>(
    '@/backend/services/session'
  );
  const execution: EventAgentExecution =
    provider === 'CLAUDE'
      ? {
          version: 1,
          provider,
          model: 'sonnet',
          reasoningEffort: 'high',
          codexAccountId: null,
          startupModePreset: 'non_interactive',
          accessMode: 'bypassPermissions',
          planModeEnabled: false,
        }
      : {
          version: 1,
          provider,
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          codexAccountId: 'event-test-account',
          startupModePreset: 'non_interactive',
          accessMode: 'workspace-write',
          planModeEnabled: false,
        };
  if (execution.codexAccountId) {
    await db.prisma.codexAccount.upsert({
      where: { id: execution.codexAccountId },
      update: {},
      create: { id: execution.codexAccountId, label: 'Frozen event account', kind: 'MANAGED' },
    });
  }
  const project = await db.prisma.project.create({
    data: {
      name: 'Fixture',
      slug: crypto.randomUUID(),
      repoPath: db.tempDir,
      worktreeBasePath: db.tempDir,
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: { projectId: project.id, name: 'Agent', instructions: 'Frozen task', isEnabled: true },
  });
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'GITHUB',
      externalId: `gh:${project.id}`,
      name: 'Repo',
      sourceState: {
        create: { isReady: true, lastSourceOrder: admission === 'persisted' ? 1 : 0 },
      },
    },
  });
  const trigger = await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: definition.id,
      connectionId: connection.id,
      type: 'GITHUB_ISSUE',
      description: 'Labels',
      config: { version: 1, repositoryIds: [project.id], actions: ['labeled'] },
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
    },
  });
  // Downstream delivery/recovery tests start at the durable queued-run boundary.
  // Bootstrap capture tests keep the full source -> evaluation -> admission path below.
  if (admission === 'persisted') {
    const now = new Date();
    const event = await db.prisma.agentEvent.create({
      data: {
        connectionId: connection.id,
        providerEventId: 'event-1',
        sourceOrder: 1,
        occurredAt: now,
        observedAt: now,
        payloadExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
        identityExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
        payload: agentEventPayloadSchema.parse({
          version: 1,
          provider: 'GITHUB',
          repositoryId: project.id,
          repositoryFullName: 'org/repo',
          action: 'labeled',
          actorId: 'human',
          creatorId: 'human',
          occurredAt: now.toISOString(),
          observedAt: now.toISOString(),
          sourceUrl: 'https://github.com/org/repo/issues/1',
          issue: { number: 1, title: 'Task', body: 'Frozen issue', addedLabel: 'agent' },
        }),
      },
    });
    const snapshot = agentEvaluationSnapshotSchema.parse({
      executionConfig: { version: 1, provider, model: execution.model, reasoningEffort: 'high' },
      definition: {
        name: definition.name,
        instructions: definition.instructions,
        isEnabled: true,
        executionConfig: { version: 1, provider, model: execution.model, reasoningEffort: 'high' },
      },
      trigger: {
        type: trigger.type,
        description: trigger.description,
        isEnabled: true,
        connectionId: connection.id,
        config: trigger.config,
      },
      input: { version: 1, eventId: event.id, context: [{ id: 'issue', text: 'Frozen issue' }] },
    });
    const messageId = crypto.randomUUID();
    const run = await db.prisma.agentRun.create({
      data: {
        agentDefinitionId: definition.id,
        triggerId: trigger.id,
        eventId: event.id,
        idempotencyKey: `event:${event.id}`,
        activationGeneration: 1,
        definitionSnapshot: snapshot.definition,
        triggerSnapshot: snapshot.trigger,
        input: snapshot.input,
        reservedWorkspaceId: crypto.randomUUID(),
        reservedSessionId: crypto.randomUUID(),
        initialMessageId: messageId,
        expiresAt: new Date(now.getTime() + 86_400_000),
        initialDelivery: { create: { sendAttemptId: crypto.randomUUID(), messageId } },
      },
    });
    await db.prisma.agentEvaluation.create({
      data: {
        eventId: event.id,
        connectionId: connection.id,
        agentDefinitionId: definition.id,
        triggerId: trigger.id,
        definitionRevision: 1,
        triggerRevision: 1,
        activationGeneration: 1,
        status: 'MATCHED',
        reasonCode: 'DETERMINISTIC_MATCH',
        explanation: 'Matched',
        configurationSnapshot: snapshot,
        runId: run.id,
        expiresAt: event.payloadExpiresAt,
      },
    });
    return { owner, workspace, session, execution, project, input: snapshot.input };
  }
  let capture = false;
  const poller = new owner.AgentSourcePollService(
    {
      getRepositoryIdentity: async () => ({ id: project.id, name: 'org/repo' }),
      classifyError: () => 'unknown',
      listIssueEvents: async () => ({
        nextPage: null,
        events: capture
          ? [
              {
                providerEventId: 'event-1',
                payload: {
                  version: 1,
                  provider: 'GITHUB',
                  repositoryId: project.id,
                  repositoryFullName: 'org/repo',
                  action: 'labeled',
                  actorId: 'human',
                  creatorId: 'human',
                  occurredAt: new Date().toISOString(),
                  observedAt: new Date().toISOString(),
                  sourceUrl: 'https://github.com/org/repo/issues/1',
                  issue: { number: 1, title: 'Task', body: 'Frozen issue', addedLabel: 'agent' },
                },
              },
            ]
          : [],
      }),
    },
    () => 10
  );
  await poller.prepareBaseline(connection.id, new AbortController().signal);
  capture = true;
  await poller.pollCycle(new AbortController().signal);
  const event = await db.prisma.agentEvent.findFirstOrThrow({
    where: { connectionId: connection.id },
  });
  const input = {
    version: 1 as const,
    eventId: event.id,
    context: [{ id: 'issue', text: 'Frozen issue' }],
  };
  const evaluation = await owner.recordEvaluation({
    eventId: event.id,
    triggerId: trigger.id,
    agentDefinitionId: definition.id,
    definitionRevision: 1,
    triggerRevision: 1,
    activationGeneration: 1,
    status: 'MATCHED',
    reasonCode: 'DETERMINISTIC_MATCH',
    explanation: 'Matched',
    executionConfig: { version: 1, provider, model: execution.model, reasoningEffort: 'high' },
    input,
  });
  if (!('evaluationId' in evaluation)) {
    throw new Error(`Evaluation failed: ${JSON.stringify(evaluation)}`);
  }
  await owner.admitRun({
    evaluationId: evaluation.evaluationId,
    definitionRevision: 1,
    triggerRevision: 1,
    activationGeneration: 1,
  });
  return { owner, workspace, session, execution, project, input };
}

/** Capture and admit through the real source ledger for bootstrap integration coverage. */
export function createEventAdmissionSeed(
  db: IntegrationDatabase,
  provider: 'CLAUDE' | 'CODEX' = 'CLAUDE'
) {
  return createEventSeed(db, provider, 'source');
}

/** Schema-valid admitted state; claiming, launch, delivery and recovery remain real. */
function createQueuedEventSeed(db: IntegrationDatabase, provider: 'CLAUDE' | 'CODEX' = 'CLAUDE') {
  return createEventSeed(db, provider, 'persisted');
}

/** Compatibility composition for delivery tests; production bootstrap tests use the pure seed. */
export async function createEventAdmissionFixture(
  db: IntegrationDatabase,
  provider: 'CLAUDE' | 'CODEX' = 'CLAUDE'
) {
  const seed = await createQueuedEventSeed(db, provider);
  const { captureWorkspaceRunResults } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator')
  >('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator');
  seed.workspace.workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
  return seed;
}

export async function createEventDeliveryFixture(
  db: IntegrationDatabase,
  provider: 'CLAUDE' | 'CODEX' = 'CLAUDE',
  ready = true,
  unprepared = false
) {
  const { owner, workspace, session, execution, project, input } =
    await createEventAdmissionFixture(db, provider);
  const claim = await owner.claimNextRun();
  if (claim.status !== 'CLAIMED') {
    throw new Error(`Claim failed: ${JSON.stringify(claim)}`);
  }
  const binding = await owner.readEventExecutionBinding(claim);
  if (!unprepared) {
    await owner.freezeEventExecution({ claim, ...binding, execution });
  }
  const source = {
    type: 'EVENT_AGENT' as const,
    ...claim,
    projectId: project.id,
    name: 'Event fixture',
    execution,
    input,
  };
  // The strict creation schema deliberately rejects claim-only fields.
  const workspaceSource = {
    type: source.type,
    runId: claim.runId,
    projectId: project.id,
    reservedWorkspaceId: claim.reservedWorkspaceId,
    reservedSessionId: claim.reservedSessionId,
    initialMessageId: claim.initialMessageId,
    name: source.name,
    execution,
    input,
  };
  const creation = new workspace.WorkspaceCreationService({
    logger: createLogger('event-fixture'),
  });
  if (!unprepared) {
    await creation.createEventWorkspaceOnce(workspaceSource);
    await session.sessionDataService.createEventSessionOnce({
      id: claim.reservedSessionId,
      workspaceId: claim.reservedWorkspaceId,
      runId: claim.runId,
      execution,
    });
    // Explicit fixture precondition. Production create→link→setup ordering belongs to4c2.
    await db.prisma.agentRun.update({
      where: { id: claim.runId },
      data: { workspaceId: claim.reservedWorkspaceId },
    });
  }
  if (ready && !unprepared) {
    await workspace.workspaceStateMachine.startProvisioning(claim.reservedWorkspaceId);
    await workspace.workspaceRunScriptService.registerInitializedWorktree(
      claim.reservedWorkspaceId,
      {
        worktreePath: db.tempDir,
        branchName: 'fixture',
        isAutoGeneratedBranch: false,
        runScriptCommand: null,
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: null,
      }
    );
    await workspace.workspaceStateMachine.markReady(claim.reservedWorkspaceId);
  }
  session.eventSessionAuthority.configure(owner.agentInitialDelivery);
  const activity = {
    markSessionRunning: (w: string, s: string) =>
      workspace.workspaceActivityService.markSessionRunning(w, s),
    markSessionIdle: (w: string, s: string) =>
      workspace.workspaceActivityService.markSessionIdle(w, s),
    resetPRDiscoveryBackoff: (id: string) =>
      workspace.workspaceDataService.resetPRDiscoveryBackoff(id),
  };
  session.sessionService.configure({ workspace: activity });
  session.sessionLifecycleService.configure({
    workspace: activity,
    messageQueue: {
      tryDispatchNextMessage: (id, options) =>
        session.sessionDispatchService.tryDispatchNextMessage(id, ...(options ? [options] : [])),
    },
  });
  session.sessionDispatchService.configure({
    initPolicy: { getWorkspaceInitPolicy: workspace.getWorkspaceInitPolicy },
  });
  const attempt = {
    runId: claim.runId,
    sessionId: claim.reservedSessionId,
    messageId: binding.messageId,
    sendAttemptId: binding.sendAttemptId,
    workerGeneration: claim.workerGeneration,
    attemptGeneration: claim.attemptGeneration,
  };
  return {
    owner,
    workspace,
    creation,
    session,
    execution,
    claim,
    attempt,
    workspaceSource,
    read: () => owner.agentInitialDelivery.readFence(claim.runId, claim.reservedSessionId),
    dispatch: () =>
      trackEventFixtureTask(
        session.dispatchAgentInitialPrompt({
          attempt,
          text: 'Frozen task',
          assertCurrent: () => undefined,
        })
      ),
  };
}
