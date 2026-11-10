export const prismaModelNames = [
  'Project',
  'DecisionLog',
  'Workspace',
  'WorkspaceLaunchOrigin',
  'WorkspaceChildOrigin',
  'WorkspaceMetadata',
  'WorkspacePR',
  'WorkspacePRMonitoring',
  'WorkspacePRDedicatedSession',
  'WorkspacePREvent',
  'WorkspacePRDelivery',
  'WorkspacePRDiscovery',

  'WorkspaceRunScript',
  'WorkspaceNotification',
  'WorkspaceMailState',
  'CodexAccount',
  'AgentSession',
  'AgentSessionLaunchOrigin',
  'SessionLifecycleEvent',
  'TerminalSession',
  'ClosedSession',
  'UserSettings',
  'PeriodicTask',
  'PeriodicTaskExecution',
  'AgentDefinition',
  'AgentConnection',
  'AgentTrigger',
  'AgentRun',
  'AgentProposal',
  'AgentSourceState',
  'AgentSourcePage',
  'AgentSourceBaseline',
  'AgentSourceCheckpoint',
  'AgentSourceHead',
  'AgentEvent',
  'AgentEvaluation',
  'AgentInitialDelivery',
] as const;

export type PrismaModelName = (typeof prismaModelNames)[number];

/**
 * Root services are reserved for cross-cutting infrastructure that does not
 * belong to a service capsule. Keep this list deliberately small: domain
 * services must live under their owning `src/backend/services/<name>/` capsule.
 */
export const infrastructureServiceRegistry = {
  'application-update-admission.service': {
    fileName: 'application-update-admission.service.ts',
    description: 'Process-wide agent work admission during application updates',
  },
  'config.service': {
    fileName: 'config.service.ts',
    description: 'Environment and application configuration',
  },
  constants: {
    fileName: 'constants.ts',
    description: 'Shared backend service timing and retry constants',
  },
  'crypto.service': {
    fileName: 'crypto.service.ts',
    description: 'Encryption for secrets stored at rest',
  },
  'job-runner.service': {
    fileName: 'job-runner.service.ts',
    description: 'Process-wide lifecycle for recurring background jobs',
  },
  'logger.service': {
    fileName: 'logger.service.ts',
    description: 'Process-wide structured logging',
  },
  'port.service': {
    fileName: 'port.service.ts',
    description: 'Backend server port probing',
  },
  'rate-limit-backoff': {
    fileName: 'rate-limit-backoff.ts',
    description: 'Shared API rate-limit retry policy',
  },
  'rate-limiter.service': {
    fileName: 'rate-limiter.service.ts',
    description: 'Process-wide API request rate limiting',
  },
  'server-instance.service': {
    fileName: 'server-instance.service.ts',
    description: 'Active HTTP server instance state',
  },
  'workspace-git-state.service': {
    fileName: 'workspace-git-state.service.ts',
    description: 'Process-wide workspace Git snapshot cache and invalidation',
  },
} as const;

export type InfrastructureServiceName = keyof typeof infrastructureServiceRegistry;

export const serviceNames = [
  'application-update',
  'codex-accounts',
  'session',
  'workspace',
  'terminal',
  'github',
  'linear',
  'run-script',
  'port-share',
  'settings',
  'decision-log',
  'periodic-task',
  'agent-definition',
  'search',
] as const;

export type ServiceName = (typeof serviceNames)[number];

/**
 * A capsule's declared dependencies, by how it reaches the other capsule. Each
 * dependency is listed once. `pnpm check:service-registry` verifies the first
 * two kinds against source; see the backend services guide.
 *
 * The import graph (`dependsOn`) must stay acyclic. The runtime graph, which
 * adds `bridgedDependsOn`, is not: workspace and session, and workspace and
 * GitHub, depend on each other at runtime, which is why one direction of each
 * pair is a bridge rather than an import.
 */
export type ServiceDefinition = {
  /** Capsules whose barrels this capsule imports from non-test code. */
  dependsOn: readonly ServiceName[];
  /**
   * Capsules whose capabilities orchestration hands this capsule through a
   * `configure*()` or `setHandler()` call at startup.
   */
  bridgedDependsOn?: readonly ServiceName[];
  /**
   * Dependencies neither imported nor bridged, such as raw SQL over another
   * capsule's tables. The checker cannot see these; the value says why the
   * dependency exists.
   */
  dataDependsOn?: Partial<Record<ServiceName, string>>;
  ownsModels: readonly PrismaModelName[];
};

export const serviceRegistry = {
  'application-update': { dependsOn: [], ownsModels: [] },
  'agent-definition': {
    dependsOn: [],
    ownsModels: [
      'AgentDefinition',
      'AgentConnection',
      'AgentTrigger',
      'AgentRun',
      'AgentProposal',
      'AgentSourceState',
      'AgentSourcePage',
      'AgentSourceBaseline',
      'AgentSourceCheckpoint',
      'AgentSourceHead',
      'AgentEvent',
      'AgentEvaluation',
      'AgentInitialDelivery',
    ],
  },
  'codex-accounts': { dependsOn: [], ownsModels: ['CodexAccount'] },
  search: {
    dependsOn: [],
    dataDependsOn: {
      workspace:
        'metadata-search.accessor.ts reads Workspace, Project, WorkspacePR and WorkspaceMetadata with read-only raw SQL.',
      session: 'metadata-search.accessor.ts reads AgentSession with read-only raw SQL.',
    },
    ownsModels: [],
  },
  session: {
    dependsOn: ['workspace', 'settings', 'codex-accounts'],
    bridgedDependsOn: ['agent-definition'],
    ownsModels: [
      'AgentSession',
      'AgentSessionLaunchOrigin',
      'ClosedSession',
      'SessionLifecycleEvent',
      'WorkspacePRDedicatedSession',
    ],
  },
  workspace: {
    dependsOn: ['settings'],
    bridgedDependsOn: ['session', 'github'],
    ownsModels: [
      'Project',
      'Workspace',
      'WorkspaceLaunchOrigin',
      'WorkspaceChildOrigin',
      'WorkspaceMetadata',
      'WorkspacePR',
      'WorkspacePRMonitoring',
      'WorkspacePREvent',
      'WorkspacePRDelivery',
      'WorkspacePRDiscovery',

      'WorkspaceRunScript',
      'WorkspaceNotification',
      'WorkspaceMailState',
    ],
  },
  terminal: {
    dependsOn: [],
    ownsModels: ['TerminalSession'],
  },
  github: {
    dependsOn: ['workspace'],
    bridgedDependsOn: ['settings'],
    ownsModels: [],
  },
  linear: {
    dependsOn: [],
    ownsModels: [],
  },
  'run-script': {
    dependsOn: ['workspace'],
    ownsModels: [],
  },
  'port-share': {
    dependsOn: [],
    ownsModels: [],
  },
  settings: {
    dependsOn: [],
    ownsModels: ['UserSettings'],
  },
  'decision-log': {
    dependsOn: [],
    ownsModels: ['DecisionLog'],
  },
  'periodic-task': {
    dependsOn: [],
    bridgedDependsOn: ['workspace', 'session'],
    ownsModels: ['PeriodicTask', 'PeriodicTaskExecution'],
  },
} as const satisfies Record<ServiceName, ServiceDefinition>;
