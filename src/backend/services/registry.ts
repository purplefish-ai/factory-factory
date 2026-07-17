export const prismaModelNames = [
  'Project',
  'DecisionLog',
  'Workspace',
  'WorkspaceNotification',
  'AgentSession',
  'TerminalSession',
  'ClosedSession',
  'UserSettings',
  'PeriodicTask',
  'PeriodicTaskExecution',
] as const;

export type PrismaModelName = (typeof prismaModelNames)[number];

/**
 * Root services are reserved for cross-cutting infrastructure that does not
 * belong to a service capsule. Keep this list deliberately small: domain
 * services must live under their owning `src/backend/services/<name>/` capsule.
 */
export const infrastructureServiceRegistry = {
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
  'logger.service': {
    fileName: 'logger.service.ts',
    description: 'Process-wide structured logging',
  },
  'notification.service': {
    fileName: 'notification.service.ts',
    description: 'Operating-system notifications',
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
  'session',
  'workspace',
  'terminal',
  'github',
  'linear',
  'ratchet',
  'run-script',
  'settings',
  'decision-log',
  'auto-iteration',
  'periodic-task',
] as const;

export type ServiceName = (typeof serviceNames)[number];

type ServiceDefinition = {
  dependsOn: readonly ServiceName[];
  ownsModels: readonly PrismaModelName[];
};

export const serviceRegistry = {
  session: {
    dependsOn: ['workspace', 'settings', 'terminal', 'github'],
    ownsModels: ['AgentSession', 'ClosedSession'],
  },
  workspace: {
    dependsOn: ['settings', 'auto-iteration'],
    ownsModels: ['Project', 'Workspace', 'WorkspaceNotification'],
  },
  terminal: {
    dependsOn: [],
    ownsModels: ['TerminalSession'],
  },
  github: {
    dependsOn: ['workspace'],
    ownsModels: [],
  },
  linear: {
    dependsOn: [],
    ownsModels: [],
  },
  ratchet: {
    dependsOn: ['session', 'workspace', 'settings', 'github'],
    ownsModels: [],
  },
  'run-script': {
    dependsOn: ['workspace'],
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
  'auto-iteration': {
    dependsOn: [],
    ownsModels: [],
  },
  'periodic-task': {
    dependsOn: ['workspace', 'settings'],
    ownsModels: ['PeriodicTask', 'PeriodicTaskExecution'],
  },
} as const satisfies Record<ServiceName, ServiceDefinition>;
