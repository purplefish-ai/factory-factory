import type fixed from './recovery-base-json-workspace-v8.fixture.json';
function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error('Missing fixture row');
  }
  return item;
}
export const malformedWorkspaceJsonCases = [
  [
    'undefined marked field',
    (f: typeof fixed) => {
      Object.assign(first(f.data.workspaces), { creationMetadata: undefined });
    },
  ],
  [
    'missing marked field',
    (f: typeof fixed) => {
      Reflect.deleteProperty(first(f.data.workspaces), 'creationMetadata');
    },
  ],
  [
    'undefined covered field',
    (f: typeof fixed) => {
      Object.assign(first(f.data.workspaces), { creationMetadata: undefined });
      f.data.recovery.baseJson.jsonStorage = [];
    },
  ],
  [
    'missing covered field',
    (f: typeof fixed) => {
      Reflect.deleteProperty(first(f.data.workspaces), 'creationMetadata');
      f.data.recovery.baseJson.jsonStorage = [];
    },
  ],
  [
    'missing section',
    (f: typeof fixed) => {
      Reflect.deleteProperty(f.data.recovery, 'baseJson');
    },
  ],
  [
    'missing declaration',
    (f: typeof fixed) => {
      Reflect.deleteProperty(f.meta.recovery.capabilities, 'baseJson');
    },
  ],
  [
    'duplicate marker',
    (f: typeof fixed) => {
      f.data.recovery.baseJson.jsonStorage.push(first(f.data.recovery.baseJson.jsonStorage));
    },
  ],
  [
    'missing target',
    (f: typeof fixed) => {
      first(f.data.recovery.baseJson.jsonStorage).identity = ['missing'];
    },
  ],
  [
    'non-null target',
    (f: typeof fixed) => {
      Object.assign(first(f.data.workspaces), { creationMetadata: {} });
    },
  ],
  [
    'wrong arity',
    (f: typeof fixed) => {
      first(f.data.recovery.baseJson.jsonStorage).identity.push('extra');
    },
  ],
  [
    'wrong model',
    (f: typeof fixed) => {
      first(f.data.recovery.baseJson.jsonStorage).model = 'AgentSession';
    },
  ],
  [
    'wrong field',
    (f: typeof fixed) => {
      first(f.data.recovery.baseJson.jsonStorage).field = 'observation';
    },
  ],
  [
    'unknown meta',
    (f: typeof fixed) => {
      Object.assign(f.meta, { future: true });
    },
  ],
  [
    'unknown data',
    (f: typeof fixed) => {
      Object.assign(f.data, { future: true });
    },
  ],
  [
    'unknown section key',
    (f: typeof fixed) => {
      Object.assign(f.data.recovery.baseJson, { future: true });
    },
  ],
  [
    'unknown marker key',
    (f: typeof fixed) => {
      Object.assign(first(f.data.recovery.baseJson.jsonStorage), { future: true });
    },
  ],
  [
    'unknown version',
    (f: typeof fixed) => {
      f.data.recovery.baseJson.version = 2;
    },
  ],
  [
    'unknown profile',
    (f: typeof fixed) => {
      f.meta.recovery.profile = 'future';
    },
  ],
  [
    'ambiguous target',
    (f: typeof fixed) => {
      f.data.workspaces.push(first(f.data.workspaces));
    },
  ],
  [
    'unknown capability',
    (f: typeof fixed) => {
      Object.assign(f.meta.recovery.capabilities, { future: 1 });
    },
  ],
  [
    'unknown capabilities version',
    (f: typeof fixed) => {
      f.meta.recovery.capabilities.baseJson = 2;
    },
  ],
  [
    'undefined declaration',
    (f: typeof fixed) => {
      Object.assign(f.meta.recovery.capabilities, { baseJson: undefined });
    },
  ],
  [
    'undefined section',
    (f: typeof fixed) => {
      Object.assign(f.data.recovery, { baseJson: undefined });
    },
  ],
  [
    'unknown recovery key',
    (f: typeof fixed) => {
      Object.assign(f.data.recovery, { future: {} });
    },
  ],
] as const;
