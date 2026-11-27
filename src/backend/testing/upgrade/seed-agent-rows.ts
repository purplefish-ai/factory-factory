import { FAR_FUTURE, iso, PROJECT_GITHUB, type SeedRow, stamp } from './seed-values';
import {
  PERIODIC_TASK_DAILY,
  RUN_EVENT,
  RUN_FIRST,
  SESSION_EVENT,
  WORKSPACE_EVENT,
  WORKSPACE_MANUAL,
  WORKSPACE_PERIODIC,
} from './seed-workspace-rows';

const CONNECTION_GITHUB = 'seed-connection-github';
const CONNECTION_SLACK = 'seed-connection-slack';
export const DEFINITION_TRIAGE = 'seed-definition-triage';
export const DEFINITION_DIGEST = 'seed-definition-digest';
export const DEFINITION_LEGACY = 'seed-definition-legacy';
export const TRIGGER_GITHUB = 'seed-trigger-github';
export const TRIGGER_SLACK = 'seed-trigger-slack';
export const TRIGGER_SCHEDULE = 'seed-trigger-schedule';
export const TRIGGER_LEGACY = 'seed-trigger-legacy';
const EVENT_GITHUB = 'seed-event-github';
const EVENT_SLACK = 'seed-event-slack';
const PROVIDER_EVENT_GITHUB = 'seed-provider-event-github';
const SCAN = 'seed-scan-1';
const ISSUE_URL = 'https://github.com/seed-org/seed-repo/issues/7';
const PR_URL = 'https://github.com/seed-org/seed-repo/pull/201';

const triageDefinition = {
  name: 'Triage issues',
  instructions: 'Reproduce the issue and open a pull request with a fix.',
  isEnabled: true,
  executionConfig: { version: 1 },
};
const githubTrigger = {
  type: 'GITHUB_ISSUE',
  description: 'Issues labeled agent',
  filterInstructions: null,
  isEnabled: true,
  connectionId: CONNECTION_GITHUB,
  config: { version: 1, repositoryIds: ['123456'], actions: ['labeled'], labels: ['agent'] },
};
const slackTrigger = {
  type: 'SLACK_MESSAGE',
  description: 'Deploy requests in the alerts channel',
  filterInstructions: 'Only requests for production',
  isEnabled: false,
  connectionId: CONNECTION_SLACK,
  config: {
    version: 1,
    channelIds: ['C0SEED'],
    messageContains: 'deploy',
    context: { includeThread: true, nearbyMessageCount: 2 },
  },
};
const scheduleTrigger = {
  type: 'SCHEDULE',
  description: 'Every weekday morning',
  filterInstructions: null,
  isEnabled: false,
  connectionId: null,
  config: { version: 1, cadence: 'DAILY', scheduledTime: '09:00', timezone: 'UTC' },
};
const runInput = {
  version: 1,
  eventId: PROVIDER_EVENT_GITHUB,
  sourceUrl: ISSUE_URL,
  context: [{ id: 'issue', text: 'The retry test fails on slow machines.', url: ISSUE_URL }],
};
const claudeExecution = {
  version: 1,
  provider: 'CLAUDE',
  model: 'sonnet',
  reasoningEffort: 'high',
  codexAccountId: null,
  startupModePreset: 'non_interactive',
  accessMode: 'bypassPermissions',
  planModeEnabled: false,
};
const validatedIntent = {
  version: 1,
  definitionRevision: 1,
  validatedAt: iso(80),
  execution: {
    version: 1,
    provider: 'CLAUDE',
    model: 'sonnet',
    requestedModel: 'sonnet',
    reasoningEffort: null,
    providerIntent: 'INHERITED',
    modelIntent: 'INHERITED',
    effortIntent: 'INHERITED',
    effortNormalization: 'NONE',
  },
};

export const agentConnections: SeedRow[] = [
  {
    id: CONNECTION_GITHUB,
    provider: 'GITHUB',
    externalId: 'gh:123456',
    name: 'seed-org/seed-repo',
    isEnabled: true,
    credentialsEncrypted: null,
    appCredentialsEncrypted: null,
    appId: null,
    createdAt: stamp(70),
    updatedAt: stamp(70),
  },
  {
    id: CONNECTION_SLACK,
    provider: 'SLACK',
    externalId: 'T0SEED',
    name: 'Seed Slack workspace',
    isEnabled: true,
    credentialsEncrypted: 'v1:seed-bot-ciphertext',
    appCredentialsEncrypted: 'v1:seed-app-ciphertext',
    appId: 'A0SEED',
    createdAt: stamp(70),
    updatedAt: stamp(71),
  },
];

export const agentDefinitions: SeedRow[] = [
  {
    id: DEFINITION_TRIAGE,
    projectId: PROJECT_GITHUB,
    name: triageDefinition.name,
    instructions: triageDefinition.instructions,
    isEnabled: true,
    executionConfig: { version: 1 },
    definitionRevision: 1,
    managementRevision: 3,
    validatedIntent,
    createdAt: stamp(72),
    updatedAt: stamp(80),
  },
  {
    id: DEFINITION_DIGEST,
    projectId: PROJECT_GITHUB,
    name: 'Daily digest',
    instructions: 'Summarise yesterday and post it.',
    isEnabled: false,
    executionConfig: { version: 1, provider: 'CODEX', model: 'gpt-5.4', reasoningEffort: 'high' },
    definitionRevision: 2,
    managementRevision: 2,
    validatedIntent: null,
    createdAt: stamp(72),
    updatedAt: stamp(81),
  },
  {
    id: DEFINITION_LEGACY,
    projectId: PROJECT_GITHUB,
    name: 'Legacy schedule',
    instructions: 'Migrated from a periodic task.',
    isEnabled: false,
    executionConfig: { version: 1 },
    definitionRevision: 1,
    managementRevision: 1,
    validatedIntent: null,
    createdAt: stamp(72),
    updatedAt: stamp(72),
  },
];

/** One trigger of each type, in each activation state. */
export const agentTriggers: SeedRow[] = [
  {
    id: TRIGGER_GITHUB,
    agentDefinitionId: DEFINITION_TRIAGE,
    type: 'GITHUB_ISSUE',
    connectionId: CONNECTION_GITHUB,
    description: githubTrigger.description,
    config: githubTrigger.config,
    filterInstructions: null,
    isEnabled: true,
    isConfigured: true,
    triggerRevision: 1,
    activationGeneration: 1,
    activationState: 'ACTIVE',
    activationBoundary: { provider: 'GITHUB', headEventId: PROVIDER_EVENT_GITHUB, sourceOrder: 1 },
    pendingActivation: null,
    pausedReasonCode: null,
    createdAt: stamp(73),
    updatedAt: stamp(82),
  },
  {
    id: TRIGGER_SLACK,
    agentDefinitionId: DEFINITION_DIGEST,
    type: 'SLACK_MESSAGE',
    connectionId: CONNECTION_SLACK,
    description: slackTrigger.description,
    config: slackTrigger.config,
    filterInstructions: slackTrigger.filterInstructions,
    isEnabled: false,
    isConfigured: true,
    triggerRevision: 1,
    activationGeneration: 1,
    activationState: 'STARTING',
    activationBoundary: null,
    pendingActivation: {
      version: 1,
      provider: 'SLACK',
      activationGeneration: 1,
      definitionRevision: 2,
      triggerRevision: 1,
      connectionId: CONNECTION_SLACK,
      expiresAt: iso(FAR_FUTURE),
      workspaceId: 'T0SEED',
      appId: 'A0SEED',
      nonce: 'abcd-efgh-jkmn',
      channels: [{ channelId: 'C0SEED', name: 'seed-alerts', eventTs: null }],
    },
    pausedReasonCode: null,
    createdAt: stamp(73),
    updatedAt: stamp(83),
  },
  {
    id: TRIGGER_SCHEDULE,
    agentDefinitionId: DEFINITION_DIGEST,
    type: 'SCHEDULE',
    connectionId: null,
    description: scheduleTrigger.description,
    config: scheduleTrigger.config,
    filterInstructions: null,
    isEnabled: false,
    isConfigured: true,
    triggerRevision: 1,
    activationGeneration: 0,
    activationState: 'PAUSED',
    activationBoundary: null,
    pendingActivation: null,
    pausedReasonCode: 'ACTIVATION_EXPIRED',
    createdAt: stamp(73),
    updatedAt: stamp(84),
  },
  {
    // Rows written before trigger membership was recorded have `isConfigured` NULL.
    id: TRIGGER_LEGACY,
    agentDefinitionId: DEFINITION_LEGACY,
    type: 'SCHEDULE',
    connectionId: null,
    description: 'Every morning',
    config: scheduleTrigger.config,
    filterInstructions: null,
    isEnabled: false,
    isConfigured: null,
    triggerRevision: 1,
    activationGeneration: 0,
    activationState: 'PAUSED',
    activationBoundary: null,
    pendingActivation: null,
    pausedReasonCode: null,
    createdAt: stamp(73),
    updatedAt: stamp(73),
  },
];

const specification = {
  name: 'Triage issues',
  instructions: 'Reproduce the issue and open a pull request with a fix.',
  executionConfig: { version: 1 },
  triggers: [
    {
      id: 'seed-proposal-trigger-1',
      type: 'GITHUB_ISSUE',
      description: 'Issues labeled agent',
      filterInstructions: null,
      isEnabled: false,
      connectionId: CONNECTION_GITHUB,
      config: { version: 1, repositoryIds: ['123456'], actions: ['labeled'], labels: ['agent'] },
    },
  ],
};

export const agentProposals: SeedRow[] = [
  {
    id: 'seed-proposal-accepted',
    workspaceId: WORKSPACE_MANUAL,
    revision: 2,
    specification,
    sourceNames: { [CONNECTION_GITHUB]: 'seed-org/seed-repo' },
    agentDefinitionId: DEFINITION_TRIAGE,
    createdAt: stamp(60),
    updatedAt: stamp(72),
  },
  {
    id: 'seed-proposal-draft',
    workspaceId: WORKSPACE_MANUAL,
    revision: 1,
    specification: { ...specification, name: 'Draft agent' },
    sourceNames: {},
    agentDefinitionId: null,
    createdAt: stamp(61),
    updatedAt: stamp(61),
  },
];

export const agentSourceStates: SeedRow[] = [
  {
    connectionId: CONNECTION_GITHUB,
    authorityRevision: 0,
    lastSourceOrder: 1,
    epoch: 0,
    epochStartSourceOrder: 0,
    isReady: true,
    cursor: {
      version: 1,
      provider: 'GITHUB',
      committedHeadEventId: PROVIDER_EVENT_GITHUB,
      scan: null,
    },
    health: { state: 'READY', reasonCode: null, updatedAt: iso(85) },
    lastObservedAt: stamp(85),
    updatedAt: stamp(85),
  },
  {
    connectionId: CONNECTION_SLACK,
    authorityRevision: 0,
    lastSourceOrder: 0,
    epoch: 1,
    epochStartSourceOrder: 0,
    isReady: false,
    cursor: { version: 1, provider: 'SLACK', gaps: [{ from: iso(86), to: null }] },
    health: { state: 'CATCHING_UP', reasonCode: 'SLACK_GAP', updatedAt: iso(86) },
    lastObservedAt: null,
    updatedAt: stamp(86),
  },
];

export const agentEvents: SeedRow[] = [
  {
    id: EVENT_GITHUB,
    connectionId: CONNECTION_GITHUB,
    providerEventId: PROVIDER_EVENT_GITHUB,
    sourceOrder: 1,
    sourceEpoch: 0,
    payload: {
      version: 1,
      provider: 'GITHUB',
      occurredAt: iso(87),
      observedAt: iso(88),
      sourceUrl: ISSUE_URL,
      repositoryId: '123456',
      repositoryFullName: 'seed-org/seed-repo',
      action: 'labeled',
      actorId: '1001',
      creatorId: '1002',
      issue: {
        number: 7,
        title: 'Retry test fails on slow machines',
        body: 'The retry test times out when the machine is under load.',
        addedLabel: 'agent',
        labels: ['agent', 'bug'],
      },
    },
    occurredAt: stamp(87),
    observedAt: stamp(88),
    payloadExpiresAt: stamp(FAR_FUTURE),
    identityExpiresAt: stamp(FAR_FUTURE),
    createdAt: stamp(88),
  },
  {
    id: EVENT_SLACK,
    connectionId: CONNECTION_SLACK,
    providerEventId: 'seed-provider-event-slack',
    sourceOrder: null,
    sourceEpoch: 1,
    payload: {
      version: 1,
      provider: 'SLACK',
      occurredAt: iso(89),
      observedAt: iso(89),
      sourceUrl: 'https://seed.slack.com/archives/C0SEED/p1700000000000100',
      actorId: 'U0SEED',
      workspaceId: 'T0SEED',
      appId: 'A0SEED',
      channelId: 'C0SEED',
      action: 'message',
      eventTs: '1700000000.000100',
      threadTs: null,
      actorType: 'HUMAN',
      subtype: null,
      text: 'please deploy the staging build',
    },
    occurredAt: stamp(89),
    observedAt: stamp(89),
    payloadExpiresAt: stamp(FAR_FUTURE),
    identityExpiresAt: stamp(FAR_FUTURE),
    createdAt: stamp(89),
  },
];

export const agentSourcePages: SeedRow[] = [
  {
    id: 'seed-source-page-1',
    connectionId: CONNECTION_GITHUB,
    scanId: SCAN,
    ordinal: 0,
    phase: 'FINALIZED',
    requestPage: 1,
    nextPage: null,
    sourceOrder: 1,
    evidence: {
      ids: [PROVIDER_EVENT_GITHUB],
      entries: [{ providerEventId: PROVIDER_EVENT_GITHUB, eventId: EVENT_GITHUB }],
    },
    epoch: 0,
    createdAt: stamp(90),
  },
];

export const agentSourceCheckpoints: SeedRow[] = [
  {
    connectionId: CONNECTION_GITHUB,
    scanId: SCAN,
    status: 'COMPLETE',
    nextOrdinal: 1,
    entryCount: 1,
    executableCount: 1,
    verifiedCount: 1,
    verification: { version: 1, nextPage: 1, resumePage: 1, resumeCount: 0, seekingOverlap: false },
    headEventId: PROVIDER_EVENT_GITHUB,
    boundaryKnown: true,
    previousBoundaryEventId: null,
    initialSourceOrder: 1,
    sourceOrder: 1,
    validationCursor: {
      version: 2,
      boundaryWitnessed: true,
      revision: 0,
      phase: 'BASELINES',
      scanId: SCAN,
      position: 0,
      baselineId: 'seed-baseline-1',
      headCount: 1,
    },
    epoch: 0,
  },
];

export const agentSourceHeads: SeedRow[] = [
  {
    connectionId: CONNECTION_GITHUB,
    scanId: SCAN,
    providerEventId: PROVIDER_EVENT_GITHUB,
    position: 0,
    precedingEventCount: 0,
    epoch: 0,
  },
];

export const agentSourceBaselines: SeedRow[] = [
  {
    id: 'seed-baseline-1',
    connectionId: CONNECTION_GITHUB,
    headEventId: PROVIDER_EVENT_GITHUB,
    afterHeadEventId: null,
    sourceOrder: 1,
    epoch: 0,
    createdAt: stamp(91),
  },
];

const runDefaults: SeedRow = {
  triggerId: null,
  eventId: null,
  definitionRevision: 1,
  triggerRevision: 1,
  activationGeneration: 1,
  workerGeneration: 1,
  attemptGeneration: 1,
  attemptCount: 1,
  nextAttemptAt: null,
  leaseExpiresAt: null,
  expiresAt: null,
  reasonCode: null,
  result: null,
  effectiveExecution: claudeExecution,
  launchPreparation: { version: 1, state: 'SAFE', setupStartedAt: null },
  contextExpiredAt: null,
  definitionSnapshot: triageDefinition,
  triggerSnapshot: githubTrigger,
  input: runInput,
  workspaceId: null,
  errorMessage: null,
  createdAt: stamp(100),
  startedAt: stamp(101),
  completedAt: null,
};
const reserved = (name: string): SeedRow => ({
  reservedWorkspaceId: `seed-reserved-workspace-${name}`,
  reservedSessionId: `seed-reserved-session-${name}`,
  initialMessageId: `seed-message-${name}`,
});

/** Seven launch phases and six run statuses across nine runs of the triage definition. */
export const agentRuns: SeedRow[] = [
  {
    ...runDefaults,
    id: RUN_FIRST,
    agentDefinitionId: DEFINITION_TRIAGE,
    triggerId: TRIGGER_GITHUB,
    eventId: EVENT_GITHUB,
    idempotencyKey: 'event:seed-event-github',
    status: 'QUEUED',
    launchPhase: 'RESERVED',
    reservedWorkspaceId: null,
    reservedSessionId: null,
    initialMessageId: null,
    workerGeneration: 0,
    attemptCount: 0,
    effectiveExecution: null,
    launchPreparation: null,
    startedAt: null,
  },
  {
    ...runDefaults,
    ...reserved('provisioning'),
    id: 'seed-run-provisioning',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:provisioning',
    status: 'RUNNING',
    launchPhase: 'PROVISIONING',
    triggerSnapshot: null,
    launchPreparation: { version: 1, state: 'SETUP', setupStartedAt: iso(101) },
    leaseExpiresAt: stamp(110),
  },
  {
    ...runDefaults,
    ...reserved('ready'),
    id: 'seed-run-ready',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:ready',
    status: 'RUNNING',
    launchPhase: 'READY',
    triggerSnapshot: null,
  },
  {
    ...runDefaults,
    ...reserved('dispatching'),
    id: 'seed-run-dispatching',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:dispatching',
    status: 'RUNNING',
    launchPhase: 'DISPATCHING',
    triggerSnapshot: null,
  },
  {
    ...runDefaults,
    id: RUN_EVENT,
    agentDefinitionId: DEFINITION_DIGEST,
    triggerId: TRIGGER_SLACK,
    eventId: EVENT_SLACK,
    idempotencyKey: 'event:seed-event-slack',
    status: 'RUNNING',
    launchPhase: 'ACTIVE',
    reservedWorkspaceId: WORKSPACE_EVENT,
    reservedSessionId: SESSION_EVENT,
    initialMessageId: 'seed-message-active',
    workspaceId: WORKSPACE_EVENT,
    definitionSnapshot: {
      ...triageDefinition,
      name: 'Daily digest',
      instructions: 'Summarise yesterday and post it.',
      isEnabled: false,
    },
    triggerSnapshot: slackTrigger,
    input: { version: 1, eventId: 'seed-provider-event-slack', context: [] },
  },
  {
    ...runDefaults,
    ...reserved('attention'),
    id: 'seed-run-attention',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:attention',
    status: 'FAILED',
    launchPhase: 'NEEDS_ATTENTION',
    triggerSnapshot: null,
    reasonCode: 'DELIVERY_AMBIGUOUS',
    errorMessage: 'The first message may or may not have reached the agent.',
    completedAt: stamp(105),
  },
  {
    ...runDefaults,
    ...reserved('completed'),
    id: 'seed-run-completed',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:completed',
    status: 'COMPLETED',
    launchPhase: 'FINISHED',
    triggerSnapshot: null,
    result: { version: 1, summary: 'Found nothing to fix.', pullRequests: [] },
    completedAt: stamp(106),
  },
  {
    ...runDefaults,
    ...reserved('pr'),
    id: 'seed-run-pr-created',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:pr-created',
    status: 'PR_CREATED',
    launchPhase: 'FINISHED',
    triggerSnapshot: null,
    result: {
      version: 1,
      summary: 'Opened a fix.',
      pullRequests: [{ url: PR_URL, number: 201 }],
    },
    completedAt: stamp(107),
  },
  {
    ...runDefaults,
    ...reserved('cancelled'),
    id: 'seed-run-cancelled',
    agentDefinitionId: DEFINITION_TRIAGE,
    idempotencyKey: 'manual:cancelled',
    status: 'CANCELLED',
    launchPhase: 'FINISHED',
    reasonCode: 'SOURCE_RESET',
    contextExpiredAt: stamp(108),
    definitionSnapshot: { version: 1, state: 'EXPIRED', expiredAt: iso(108) },
    triggerSnapshot: { version: 1, state: 'EXPIRED', expiredAt: iso(108) },
    input: { version: 1, state: 'EXPIRED', expiredAt: iso(108) },
    completedAt: stamp(108),
  },
];

const attempt = (run: string, message: string, sendAttempt: string, session: string) => ({
  runId: run,
  sessionId: session,
  messageId: message,
  sendAttemptId: sendAttempt,
  workerGeneration: 1,
  attemptGeneration: 1,
});
const providerSource = {
  version: 1,
  provider: 'CLAUDE',
  providerSessionId: 'native-event-1',
  runtimeIncarnationId: 'seed-runtime-1',
  lifecycleGeneration: 1,
};

const deliveryDefaults: SeedRow = {
  attemptGeneration: 1,
  providerTurnId: null,
  sendingAt: null,
  acceptedAt: null,
  finishedAt: null,
  evidence: null,
  createdAt: stamp(102),
  updatedAt: stamp(103),
};

/** One initial delivery per `AgentDeliveryState`. */
export const agentInitialDeliveries: SeedRow[] = [
  {
    ...deliveryDefaults,
    id: 'seed-delivery-ready',
    runId: 'seed-run-ready',
    state: 'PENDING',
    sendAttemptId: 'seed-send-ready',
    messageId: 'seed-message-ready',
  },
  {
    ...deliveryDefaults,
    id: 'seed-delivery-dispatching-run',
    runId: 'seed-run-dispatching',
    state: 'SENDING',
    sendAttemptId: 'seed-send-dispatching',
    messageId: 'seed-message-dispatching',
    sendingAt: stamp(103),
    evidence: {
      version: 1,
      attempt: attempt(
        'seed-run-dispatching',
        'seed-message-dispatching',
        'seed-send-dispatching',
        'seed-reserved-session-dispatching'
      ),
      source: providerSource,
    },
  },
  {
    ...deliveryDefaults,
    id: 'seed-delivery-active',
    runId: RUN_EVENT,
    state: 'ACCEPTED',
    sendAttemptId: 'seed-send-active',
    messageId: 'seed-message-active',
    providerTurnId: 'seed-turn-1',
    sendingAt: stamp(103),
    acceptedAt: stamp(104),
    evidence: {
      version: 1,
      attempt: attempt(RUN_EVENT, 'seed-message-active', 'seed-send-active', SESSION_EVENT),
      source: providerSource,
    },
  },
  {
    ...deliveryDefaults,
    id: 'seed-delivery-attention',
    runId: 'seed-run-attention',
    state: 'AMBIGUOUS',
    sendAttemptId: 'seed-send-attention',
    messageId: 'seed-message-attention',
    sendingAt: stamp(103),
    evidence: {
      version: 1,
      attempt: attempt(
        'seed-run-attention',
        'seed-message-attention',
        'seed-send-attention',
        'seed-reserved-session-attention'
      ),
      source: providerSource,
    },
  },
  {
    ...deliveryDefaults,
    id: 'seed-delivery-completed',
    runId: 'seed-run-completed',
    state: 'FINISHED',
    sendAttemptId: 'seed-send-completed',
    messageId: 'seed-message-completed',
    providerTurnId: 'seed-turn-2',
    sendingAt: stamp(103),
    acceptedAt: stamp(104),
    finishedAt: stamp(106),
    evidence: {
      version: 1,
      attempt: attempt(
        'seed-run-completed',
        'seed-message-completed',
        'seed-send-completed',
        'seed-reserved-session-completed'
      ),
      source: providerSource,
      outcome: { source: providerSource, stopReason: 'end_turn', result: 'COMPLETED' },
    },
  },
];

const snapshot = (definition: SeedRow, trigger: SeedRow): SeedRow => ({
  definition,
  trigger,
  executionConfig: { version: 1, provider: 'CLAUDE', model: 'sonnet' },
  input: runInput,
});
const classifier = {
  provider: 'CLAUDE',
  model: 'haiku',
  promptVersion: 'seed-prompt-v1',
  inputHash: 'a'.repeat(64),
};
const evaluationDefaults: SeedRow = {
  definitionRevision: 1,
  triggerRevision: 1,
  attemptCount: 1,
  nextAttemptAt: null,
  runId: null,
  classifier: null,
  expiresAt: stamp(FAR_FUTURE),
  createdAt: stamp(95),
  updatedAt: stamp(96),
};

/** One evaluation per `AgentEvaluationStatus`. */
export const agentEvaluations: SeedRow[] = [
  {
    ...evaluationDefaults,
    id: 'seed-evaluation-matched',
    eventId: EVENT_GITHUB,
    connectionId: CONNECTION_GITHUB,
    agentDefinitionId: DEFINITION_TRIAGE,
    triggerId: TRIGGER_GITHUB,
    activationGeneration: 1,
    status: 'MATCHED',
    reasonCode: 'MATCHED',
    explanation: 'The label matched the trigger.',
    configurationSnapshot: snapshot(triageDefinition, githubTrigger),
    classifier,
    runId: RUN_FIRST,
  },
  {
    ...evaluationDefaults,
    id: 'seed-evaluation-skipped',
    eventId: EVENT_SLACK,
    connectionId: CONNECTION_SLACK,
    agentDefinitionId: DEFINITION_DIGEST,
    triggerId: TRIGGER_SLACK,
    activationGeneration: 0,
    status: 'SKIPPED',
    reasonCode: 'NOT_MATCHED',
    explanation: 'The message was not about a production deploy.',
    configurationSnapshot: snapshot(
      { ...triageDefinition, name: 'Daily digest', isEnabled: false },
      slackTrigger
    ),
    classifier,
  },
  {
    ...evaluationDefaults,
    id: 'seed-evaluation-error',
    eventId: EVENT_SLACK,
    connectionId: CONNECTION_SLACK,
    agentDefinitionId: DEFINITION_DIGEST,
    triggerId: TRIGGER_SLACK,
    activationGeneration: 1,
    status: 'ERROR',
    reasonCode: 'INVALID_STORED_DATA',
    explanation: 'The stored configuration could not be read.',
    configurationSnapshot: {
      version: 1,
      kind: 'NON_DISPATCHING',
      definition: {
        name: 'Daily digest',
        instructions: 'Summarise yesterday and post it.',
        isEnabled: false,
        executionConfig: { version: 1, provider: 'CODEX', model: 'gpt-5.4' },
      },
      trigger: slackTrigger,
      input: { version: 1, eventId: 'seed-provider-event-slack', context: [] },
    },
    attemptCount: 3,
    nextAttemptAt: stamp(97),
  },
];

export const workspaceLaunchOrigins: SeedRow[] = [
  {
    runId: RUN_EVENT,
    workspaceId: WORKSPACE_EVENT,
    projectId: PROJECT_GITHUB,
    childHistoryVersion: 1,
    createdAt: stamp(17),
  },
];

export const agentSessionLaunchOrigins: SeedRow[] = [
  {
    runId: RUN_EVENT,
    sessionId: SESSION_EVENT,
    workspaceId: WORKSPACE_EVENT,
    execution: claudeExecution,
    createdAt: stamp(17),
  },
];

/** Periodic executions, one per status; the first has the legacy shape without a snapshot. */
export const periodicTaskExecutions: SeedRow[] = (
  [
    ['RUNNING', null, null, null],
    ['PR_CREATED', WORKSPACE_PERIODIC, PR_URL, 201],
    ['COMPLETED', null, null, null],
    ['FAILED', null, null, null],
    ['SKIPPED', null, null, null],
  ] as const
).map(([status, workspaceId, prUrl, prNumber], index): SeedRow => ({
  id: `seed-periodic-execution-${status.toLowerCase()}`,
  periodicTaskId: PERIODIC_TASK_DAILY,
  workspaceId,
  status,
  prUrl,
  prNumber,
  errorMessage: status === 'FAILED' ? 'The workspace could not be created.' : null,
  startedAt: stamp(110 + index),
  completedAt: status === 'RUNNING' ? null : stamp(115 + index),
  launchSnapshot:
    index === 0
      ? null
      : {
          version: 1,
          projectId: PROJECT_GITHUB,
          name: `Daily dependency check - run ${index}`,
          prompt: 'Look for outdated dependencies',
          cadence: 'DAILY',
          scheduledTime: '09:00',
          timezone: 'UTC',
          scheduledDayOfMonth: null,
          dueAt: iso(110 + index),
        },
}));
