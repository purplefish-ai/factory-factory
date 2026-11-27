import { iso, type SeedRow, stamp, UNUSED_PID } from './seed-values';
import {
  CODEX_ACCOUNT_MANAGED,
  PR_DRAFT,
  PR_MERGED,
  PR_OPEN,
  PR_OPEN_OBSERVATION,
  SESSION_CLAUDE_FAILED,
  SESSION_CLAUDE_IDLE,
  SESSION_CLAUDE_PAUSED,
  SESSION_CODEX_COMPLETED,
  SESSION_CODEX_RUNNING,
  SESSION_EVENT,
  WORKSPACE_ARCHIVED,
  WORKSPACE_EVENT,
  WORKSPACE_MANUAL,
  WORKSPACE_RESUME,
} from './seed-workspace-rows';

export const CLAUDE_NATIVE_SESSION = 'native-claude-1';

const sessionDefaults: SeedRow = {
  name: null,
  workspacePrId: null,
  providerSessionId: null,
  providerProjectPath: null,
  providerProcessPid: null,
  providerMetadata: null,
  codexAccountId: null,
  createdAt: stamp(20),
  updatedAt: stamp(30),
};

const claudeSnapshot = {
  provider: 'CLAUDE',
  providerSessionId: CLAUDE_NATIVE_SESSION,
  capturedAt: iso(25),
  observedModelId: 'sonnet',
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    },
  ],
};

/** One session per `SessionStatus` and provider, plus the one an event run reserved. */
export const agentSessions: SeedRow[] = [
  {
    ...sessionDefaults,
    id: SESSION_CLAUDE_IDLE,
    workspaceId: WORKSPACE_MANUAL,
    name: 'Main session',
    workflow: 'implement',
    model: 'sonnet',
    status: 'IDLE',
    provider: 'CLAUDE',
    providerSessionId: CLAUDE_NATIVE_SESSION,
    providerProjectPath: '/tmp/ff-upgrade-seed/claude-projects/fix-flaky-test',
    providerMetadata: {
      launchSettings: {
        accessMode: 'default',
        reasoningEffort: 'high',
        planModeEnabled: false,
        applied: true,
      },
      acpConfigSnapshot: claudeSnapshot,
      observedModelId: 'sonnet',
    },
  },
  {
    ...sessionDefaults,
    id: SESSION_CODEX_RUNNING,
    workspaceId: WORKSPACE_MANUAL,
    name: 'Codex review',
    workflow: 'review',
    model: 'gpt-5.4',
    status: 'RUNNING',
    provider: 'CODEX',
    codexAccountId: CODEX_ACCOUNT_MANAGED,
    providerSessionId: 'native-codex-1',
    providerProcessPid: UNUSED_PID,
    providerMetadata: { launchSettings: { accessMode: 'workspace-write', applied: false } },
  },
  {
    ...sessionDefaults,
    id: SESSION_CLAUDE_PAUSED,
    workspaceId: WORKSPACE_MANUAL,
    workflow: 'explore',
    model: 'opus',
    status: 'PAUSED',
    provider: 'CLAUDE',
  },
  {
    ...sessionDefaults,
    id: SESSION_CODEX_COMPLETED,
    workspaceId: WORKSPACE_RESUME,
    name: 'Dedicated PR session',
    workflow: 'pr-monitoring',
    model: 'gpt-5.4',
    status: 'COMPLETED',
    provider: 'CODEX',
    codexAccountId: 'codex-native-default',
    workspacePrId: PR_DRAFT,
  },
  {
    ...sessionDefaults,
    id: SESSION_CLAUDE_FAILED,
    workspaceId: WORKSPACE_ARCHIVED,
    workflow: 'implement',
    model: 'sonnet',
    status: 'FAILED',
    provider: 'CLAUDE',
    providerMetadata: { rollbackReason: 'startup_failed_after_create' },
  },
  {
    ...sessionDefaults,
    id: SESSION_EVENT,
    workspaceId: WORKSPACE_EVENT,
    name: 'Event agent',
    workflow: 'event-agent',
    model: 'sonnet',
    status: 'IDLE',
    provider: 'CLAUDE',
  },
];

export const sessionQuestionResponses: SeedRow[] = [
  {
    sessionId: SESSION_CLAUDE_IDLE,
    providerSessionId: CLAUDE_NATIVE_SESSION,
    toolUseId: 'toolu_seed_1',
    timestamp: stamp(26),
    summary: {
      toolUseId: 'toolu_seed_1',
      status: 'answered',
      questions: [{ question: 'Which branch should I base this on?', answers: ['main'] }],
    },
  },
];

/** Both event kinds and all eight reasons; (session, dedupeKey) is unique. */
export const sessionLifecycleEvents: SeedRow[] = (
  [
    ['TURN_INTERRUPTED', 'PROMPT_TIMEOUT'],
    ['TURN_INTERRUPTED', 'PROVIDER_ERROR'],
    ['SESSION_STOPPED', 'USER_STOP'],
    ['SESSION_STOPPED', 'SESSION_CLOSED'],
    ['SESSION_STOPPED', 'WORKSPACE_ARCHIVED'],
    ['SESSION_STOPPED', 'UNEXPECTED_EXIT'],
    ['SESSION_STOPPED', 'SYSTEM_STOP'],
    ['TURN_INTERRUPTED', 'VOICE_INTERRUPT'],
  ] as const
).map(([kind, reason], index): SeedRow => ({
  id: `seed-lifecycle-${index + 1}`,
  workspaceId: WORKSPACE_MANUAL,
  sessionId: SESSION_CLAUDE_IDLE,
  kind,
  reason,
  message: `Seeded ${reason.toLowerCase().replace(/_/g, ' ')}`,
  dedupeKey: `seed-lifecycle-key-${index + 1}`,
  createdAt: stamp(31 + index),
}));

/** One terminal per `SessionStatus`; only the running one names a process, and it does not exist. */
export const terminalSessions: SeedRow[] = (
  ['RUNNING', 'IDLE', 'PAUSED', 'COMPLETED', 'FAILED'] as const
).map((status, index): SeedRow => ({
  id: `seed-terminal-${status.toLowerCase()}`,
  workspaceId: WORKSPACE_MANUAL,
  name: index === 0 ? 'dev server' : null,
  status,
  pid: status === 'RUNNING' ? UNUSED_PID : null,
  createdAt: stamp(32 + index),
  updatedAt: stamp(33 + index),
}));

export const closedSessions: SeedRow[] = [
  {
    id: 'seed-closed-claude',
    workspaceId: WORKSPACE_ARCHIVED,
    sessionId: 'seed-closed-original-1',
    name: 'Finished implementation',
    workflow: 'implement',
    provider: 'CLAUDE',
    model: 'sonnet',
    transcriptPath: 'transcripts/seed-closed-claude.json',
    startedAt: stamp(-900),
    completedAt: stamp(-800),
  },
  {
    id: 'seed-closed-codex',
    workspaceId: WORKSPACE_ARCHIVED,
    sessionId: 'seed-closed-original-2',
    name: null,
    workflow: 'ratchet',
    provider: 'CODEX',
    model: 'gpt-5.4',
    transcriptPath: 'transcripts/seed-closed-codex.json',
    startedAt: stamp(-700),
    completedAt: stamp(-600),
  },
];

const delivered = {
  kind: 'CI_FAILED',
  target: { workspaceId: WORKSPACE_MANUAL, prId: PR_OPEN },
  observation: PR_OPEN_OBSERVATION,
};
const review = {
  identity: 'seed-review-1',
  contentHash: 'seed-content-hash-1',
  author: 'reviewer',
  body: 'Please add a regression test.',
  path: 'src/retry.ts',
  line: 12,
  url: 'https://github.com/seed-org/seed-repo/pull/101#discussion_r1',
  activityAt: iso(52),
};

export const prMonitoring: SeedRow[] = [
  {
    workspaceId: WORKSPACE_MANUAL,
    enabled: true,
    deliveryMode: 'MAIN',
    recipientSessionId: SESSION_CLAUDE_IDLE,
    bindingRevision: 2,
    eventEpoch: 3,
    deliveryPauseReason: null,
    legacySessionIds: [],
    lastCheckedAt: stamp(53),
  },
  {
    workspaceId: WORKSPACE_RESUME,
    enabled: true,
    deliveryMode: 'DEDICATED',
    recipientSessionId: null,
    bindingRevision: 1,
    eventEpoch: 1,
    deliveryPauseReason: 'SESSION_FAILED',
    legacySessionIds: ['legacy-fixer-session'],
    lastCheckedAt: null,
  },
];

export const prDedicatedSessions: SeedRow[] = [
  { prId: PR_DRAFT, sessionId: SESSION_CODEX_COMPLETED },
];

export const prDeliveries: SeedRow[] = [
  {
    id: 'seed-delivery-done',
    workspaceId: WORKSPACE_MANUAL,
    eventIds: ['seed-pr-event-ci-failed'],
    state: 'DELIVERED',
    sessionId: SESSION_CLAUDE_IDLE,
    provider: 'CLAUDE',
    providerSessionId: CLAUDE_NATIVE_SESSION,
    bindingRevision: 2,
    text: 'CI failed on the pull request.',
    attempts: 1,
    claimedAt: stamp(54),
    deliveredAt: stamp(55),
  },
  {
    id: 'seed-delivery-dispatching',
    workspaceId: WORKSPACE_MANUAL,
    eventIds: ['seed-pr-event-ci-recovered'],
    state: 'DISPATCHING',
    sessionId: SESSION_CLAUDE_IDLE,
    provider: 'CLAUDE',
    providerSessionId: CLAUDE_NATIVE_SESSION,
    bindingRevision: 2,
    text: 'CI recovered.',
    attempts: 1,
    claimedAt: stamp(58),
    deliveredAt: null,
  },
];

const eventDefaults: SeedRow = {
  attempts: 0,
  batchId: null,
  deliveryId: null,
  deliverySessionId: null,
  deliveryProvider: null,
  deliveryProviderSessionId: null,
  deliveryBindingRevision: null,
  deliveryText: null,
  claimedAt: null,
  deliveredAt: null,
  createdAt: stamp(54),
};
const target = { workspaceId: WORKSPACE_MANUAL, prId: PR_OPEN };

/** Every ledger fact kind and every event state. */
export const prEvents: SeedRow[] = [
  {
    ...eventDefaults,
    id: 'seed-pr-event-ci-failed',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_OPEN,
    kind: 'CI_FAILED',
    deduplicationKey: 'ci-failed:101:1',
    payload: delivered,
    state: 'DELIVERED',
    attempts: 1,
    batchId: 'seed-delivery-done',
    claimedAt: stamp(54),
    deliveredAt: stamp(55),
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-ci-recovered',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_OPEN,
    kind: 'CI_RECOVERED',
    deduplicationKey: 'ci-recovered:101:2',
    payload: { kind: 'CI_RECOVERED', target, observation: PR_OPEN_OBSERVATION },
    state: 'DISPATCHING',
    attempts: 1,
    batchId: 'seed-delivery-dispatching',
    claimedAt: stamp(58),
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-review',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_OPEN,
    kind: 'REVIEW_FEEDBACK',
    deduplicationKey: 'review:seed-review-1',
    payload: {
      kind: 'REVIEW_FEEDBACK',
      target,
      observation: PR_OPEN_OBSERVATION,
      reviews: [review],
    },
    state: 'PENDING',
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-conflict',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_OPEN,
    kind: 'CONFLICT_DETECTED',
    deduplicationKey: 'conflict:101:1',
    payload: { kind: 'CONFLICT_DETECTED', target, observation: PR_OPEN_OBSERVATION },
    state: 'SUPERSEDED',
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-conflict-cleared',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_OPEN,
    kind: 'CONFLICT_CLEARED',
    deduplicationKey: 'conflict-cleared:101:1',
    payload: { kind: 'CONFLICT_CLEARED', target, observation: PR_OPEN_OBSERVATION },
    state: 'CANCELLED',
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-merged',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_MERGED,
    kind: 'PR_MERGED',
    deduplicationKey: 'merged:100',
    payload: {
      kind: 'PR_MERGED',
      target: { workspaceId: WORKSPACE_MANUAL, prId: PR_MERGED },
      observation: { ...PR_OPEN_OBSERVATION, prState: 'MERGED' },
    },
    state: 'PENDING',
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-closed',
    workspaceId: WORKSPACE_MANUAL,
    prId: PR_MERGED,
    kind: 'PR_CLOSED',
    deduplicationKey: 'closed:100',
    payload: {
      kind: 'PR_CLOSED',
      target: { workspaceId: WORKSPACE_MANUAL, prId: PR_MERGED },
      observation: { ...PR_OPEN_OBSERVATION, prState: 'CLOSED' },
    },
    state: 'CANCELLED',
  },
  {
    ...eventDefaults,
    id: 'seed-pr-event-monitoring-enabled',
    workspaceId: WORKSPACE_MANUAL,
    prId: null,
    kind: 'MONITORING_ENABLED',
    deduplicationKey: 'monitoring-enabled:2',
    payload: {
      kind: 'MONITORING_ENABLED',
      workspaceId: WORKSPACE_MANUAL,
      bindingRevision: 2,
      replyToPrComments: true,
    },
    state: 'DELIVERED',
    deliveredAt: stamp(55),
  },
];
