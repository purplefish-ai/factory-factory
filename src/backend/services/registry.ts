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
    dependsOn: ['session', 'workspace', 'settings', 'terminal'],
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
