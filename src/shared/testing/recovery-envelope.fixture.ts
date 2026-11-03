import type fixed from './recovery-base-v8.fixture.json';
type Backup = typeof fixed;
function entry(file: Backup, model = 'Project') {
  const found = file.meta.recovery.coverage.find((item) => item.model === model);
  if (!found) {
    throw new Error(`Missing fixture model: ${model}`);
  }
  return found;
}
export const malformedRecoveryCases: [string, (file: Backup) => void][] = [
  [
    'undefined forbidden declaration',
    (f) => {
      Object.assign(f.meta.recovery.capabilities, { baseJson: undefined });
    },
  ],
  [
    'undefined forbidden section',
    (f) => {
      Object.assign(f.data.recovery, { baseJson: undefined });
    },
  ],
  [
    'forbidden capability and section',
    (f) => {
      Object.assign(f.meta.recovery.capabilities, { baseJson: 1 });
      Object.assign(f.data.recovery, { baseJson: { version: 1, jsonStorage: [] } });
    },
  ],
  [
    'unknown meta field',
    (f) => {
      Object.assign(f.meta, { futureField: { version: 1 } });
    },
  ],
  [
    'unknown data field',
    (f) => {
      Object.assign(f.data, { futureSection: { version: 1 } });
    },
  ],
  [
    'overall FULL status',
    (f) => {
      f.meta.recovery.status = 'FULL';
    },
  ],
  [
    'unknown capability v2',
    (f) => {
      Object.assign(f.meta.recovery.capabilities, { baseJson: 2 });
    },
  ],
  [
    'duplicate exclusions',
    (f) => {
      f.meta.recovery.exclusions[0] = 'NATIVE_ACCOUNT_HOMES';
    },
  ],
  [
    'unknown metadata field',
    (f) => {
      Object.assign(f.meta.recovery, { complete: true });
    },
  ],
  [
    'missing capabilities',
    (f) => {
      Reflect.deleteProperty(f.meta.recovery, 'capabilities');
    },
  ],
  [
    'missing exclusions',
    (f) => {
      Reflect.deleteProperty(f.meta.recovery, 'exclusions');
    },
  ],
  [
    'outer version',
    (f) => {
      f.meta.schemaVersion = 9;
    },
  ],
  [
    'envelope version',
    (f) => {
      f.meta.recovery.version = 2;
    },
  ],
  [
    'profile',
    (f) => {
      f.meta.recovery.profile = 'future';
    },
  ],
  [
    'unknown section v1',
    (f) => {
      Object.assign(f.data.recovery, { chat: { version: 1 } });
    },
  ],
  [
    'unknown section v2',
    (f) => {
      Object.assign(f.data.recovery, { chat: { version: 2 } });
    },
  ],
  [
    'declaration without section',
    (f) => {
      Object.assign(f.meta.recovery.capabilities, { baseJson: 1 });
    },
  ],
  [
    'missing metadata',
    (f) => {
      Reflect.deleteProperty(f.meta, 'recovery');
    },
  ],
  [
    'missing sections',
    (f) => {
      Reflect.deleteProperty(f.data, 'recovery');
    },
  ],
  [
    'duplicate model',
    (f) => {
      f.meta.recovery.coverage.push(entry(f));
    },
  ],
  [
    'missing model',
    (f) => {
      f.meta.recovery.coverage.pop();
    },
  ],
  [
    'unknown model',
    (f) => {
      entry(f).model = 'FutureModel';
    },
  ],
  [
    'FULL',
    (f) => {
      entry(f).status = 'FULL';
    },
  ],
  [
    'mail overclaim',
    (f) => {
      entry(f, 'WorkspaceMailState').status = 'PARTIAL';
    },
  ],
  [
    'missing exclusion',
    (f) => {
      f.meta.recovery.exclusions.pop();
    },
  ],
  [
    'changed exclusion',
    (f) => {
      f.meta.recovery.exclusions[0] = 'NONE';
    },
  ],
  [
    'physical null overclaim',
    (f) => {
      entry(f, 'Workspace').limitation = 'Complete JSON fidelity';
    },
  ],
  [
    'extra top-level field',
    (f) => {
      Object.assign(f, { future: true });
    },
  ],
  [
    'extra entry field',
    (f) => {
      Object.assign(entry(f), { total: 0 });
    },
  ],
];
