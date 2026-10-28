import { afterEach, describe, expect, it } from 'vitest';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import {
  SnapshotServerMessageSchema,
  type WorkspaceSnapshotEntry,
} from '@/shared/workspace-snapshot';
import {
  authoritativeSnapshotInput,
  changedSnapshotInput,
  snapshotClockDefaults,
  snapshotFieldPolicy,
  snapshotInputFields,
} from '@/test-utils/workspace-snapshot-contract';
import {
  SNAPSHOT_CHANGED,
  type SnapshotUpdateInput,
  WorkspaceSnapshotStore,
} from './workspace-snapshot-store.service';

const stores: WorkspaceSnapshotStore[] = [];
function createStore() {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
  });
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.clear();
  }
});

function fieldUpdate<K extends keyof SnapshotUpdateInput>(field: K): SnapshotUpdateInput {
  return { [field]: changedSnapshotInput()[field] };
}

describe('raw snapshot input contract', () => {
  it('initializes exactly every supported group clock', () => {
    const store = createStore();
    store.upsert('ws', { projectId: 'project' }, 'legacy', 0);
    expect(store.getByWorkspaceId('ws')?.fieldTimestamps).toEqual(snapshotClockDefaults);
  });

  // A missing ordinary field advances zero clocks; duplicate membership advances
  // two. Name, branch and their input-only provenance deliberately advance none.
  it.each(snapshotInputFields)('%s advances only its declared ordinary group', (field) => {
    const store = createStore();
    const baseline = authoritativeSnapshotInput();
    if (field === 'autoIteration') {
      baseline.mode = 'AUTO_ITERATION';
      baseline.autoIterationStatus = 'RUNNING';
    }
    store.upsert('ws', baseline, 'authoritative', 100);
    const before = { ...store.getByWorkspaceId('ws')!.fieldTimestamps };
    const result = store.upsert('ws', fieldUpdate(field), 'one raw input', 200);
    const { group } = snapshotFieldPolicy[field];
    const ordinary = group !== 'name' && group !== 'branch' && group !== 'provenance';
    expect(store.getByWorkspaceId('ws')?.fieldTimestamps).toEqual({
      ...before,
      ...(ordinary ? { [group]: 200 } : {}),
    });
    expect(result.accepted).toBe(group !== 'provenance');
    if (group !== 'provenance') {
      expect(store.getByWorkspaceId('ws')?.[field as keyof WorkspaceSnapshotEntry]).toEqual(
        changedSnapshotInput()[field]
      );
    }
    if (ordinary) {
      expect(
        store.upsert('ws', { [field]: authoritativeSnapshotInput()[field] }, 'stale', 150)
      ).toEqual({ accepted: false, changed: false, emitted: false });
    }
  });

  it('requires identity before an authoritative row can exist', () => {
    const store = createStore();
    const input: SnapshotUpdateInput = authoritativeSnapshotInput();
    Reflect.deleteProperty(input, 'projectId');
    expect(() => store.upsert('ws', input, 'missing identity', 100)).toThrow(
      'projectId is required'
    );
    expect(store.size()).toBe(0);
  });

  it.each(
    snapshotInputFields.filter(
      (field) => snapshotFieldPolicy[field].required && field !== 'projectId'
    )
  )('requires accepted authoritative hydration of %s', (field) => {
    const store = createStore();
    const input: SnapshotUpdateInput = authoritativeSnapshotInput();
    Reflect.deleteProperty(input, field);
    store.upsert('ws', input, 'one omitted input', 100);
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    const group = snapshotFieldPolicy[field].group;
    const rejected =
      group === 'name'
        ? { name: 'Workspace', nameUpdatedAt: Number.NaN }
        : group === 'branch'
          ? { branchName: 'feature', branchUpdatedAt: Number.NaN }
          : { [field]: authoritativeSnapshotInput()[field] };
    store.upsert('ws', rejected, 'rejected hydration', 0);
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    store.upsert('ws', { [field]: authoritativeSnapshotInput()[field] }, 'accepted hydration', 200);
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBe(1);
  });

  it('requires neither private provenance nor separately refreshed Git to claim a summary', () => {
    const store = createStore();
    const input: SnapshotUpdateInput = authoritativeSnapshotInput();
    Reflect.deleteProperty(input, 'nameUpdatedAt');
    Reflect.deleteProperty(input, 'branchUpdatedAt');
    Reflect.deleteProperty(input, 'gitStats');
    store.upsert('ws', input, 'authoritative without Git', 100);
    expect(store.getByWorkspaceId('ws')).toMatchObject({ summaryVersion: 1, gitStats: null });
  });

  it('hydrates unchanged default values without a delta until the last required input arrives', () => {
    const store = createStore();
    const input: SnapshotUpdateInput = authoritativeSnapshotInput();
    Reflect.deleteProperty(input, 'name');
    Reflect.deleteProperty(input, 'branchName');
    Reflect.deleteProperty(input, 'sessionSummaries');
    store.upsert('ws', input, 'incomplete authoritative', 100);
    const version = store.getVersion('ws');
    expect(store.upsert('ws', { sessionSummaries: [] }, 'unchanged runtime', 200)).toEqual({
      accepted: true,
      changed: false,
      emitted: false,
    });
    expect(store.publishAcceptedName('ws', '', 200)).toEqual({
      accepted: true,
      changed: false,
      emitted: false,
    });
    expect(store.getVersion('ws')).toBe(version);
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    expect(store.publishAcceptedBranch('ws', null, 200)).toEqual({
      accepted: true,
      changed: true,
      emitted: true,
    });
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      name: '',
      branchName: null,
      summaryVersion: 1,
    });
  });

  it('keeps ordered accepted name and branch fences independent of all ordinary clocks and wire payloads', () => {
    const store = createStore();
    store.upsert('ws', authoritativeSnapshotInput(), 'authoritative', 100);
    store.upsert('ws', { status: 'READY' }, 'new lifecycle', 900);
    const clocks = { ...store.getByWorkspaceId('ws')!.fieldTimestamps };
    const emitted: unknown[] = [];
    store.on(SNAPSHOT_CHANGED, ({ entry }) => {
      emitted.push(structuredClone(entry));
    });
    for (const text of ['first', 'second']) {
      expect(store.publishAcceptedName('ws', text, 200).accepted).toBe(true);
      expect(store.publishAcceptedBranch('ws', text, 200).accepted).toBe(true);
    }
    for (const timestamp of [199, 200]) {
      expect(store.canAcceptNameObservation('ws', timestamp)).toBe(false);
      expect(store.canAcceptBranchObservation('ws', timestamp)).toBe(false);
      expect(
        store.upsert(
          'ws',
          {
            name: 'stale',
            nameUpdatedAt: timestamp,
            branchName: 'stale',
            branchUpdatedAt: timestamp,
          },
          'delayed observation',
          5000
        ).accepted
      ).toBe(false);
    }
    const entry = store.getByWorkspaceId('ws')!;
    expect(entry).toMatchObject({ name: 'second', branchName: 'second', fieldTimestamps: clocks });
    const messages = [
      { type: 'snapshot_full', projectId: 'project', entries: store.getByProjectId('project') },
      { type: 'snapshot_changed', workspaceId: 'ws', entry },
    ];
    for (const payload of [
      entry,
      ...emitted,
      ...messages.map((message) => SnapshotServerMessageSchema.parse(message)),
    ]) {
      expect(JSON.stringify(payload)).not.toMatch(/nameUpdatedAt|branchUpdatedAt/);
    }
    store.upsert(
      'ws',
      { name: 'repaired', nameUpdatedAt: 201, branchName: 'repaired', branchUpdatedAt: 201 },
      'newer observation',
      6000
    );
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      name: 'repaired',
      branchName: 'repaired',
      fieldTimestamps: clocks,
    });
  });

  it('invalidates compact hydration across modes and accepts explicit null to clear old counters', () => {
    const store = createStore();
    store.upsert(
      'ws',
      {
        ...authoritativeSnapshotInput(),
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        autoIteration: changedSnapshotInput().autoIteration,
      },
      'loop',
      100
    );
    store.upsert('ws', { mode: 'STANDARD', autoIterationStatus: null }, 'mode change', 200);
    expect(store.getByWorkspaceId('ws')).toMatchObject({ autoIteration: null });
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    store.upsert('ws', { autoIteration: null }, 'known absent loop', 300);
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBe(1);
    store.upsert('ws', { mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING' }, 'new loop', 400);
    expect(store.getByWorkspaceId('ws')?.autoIteration).toEqual({
      status: 'RUNNING',
      currentIteration: null,
      maxIterations: null,
      currentMetricSummary: null,
    });
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    store.upsert('ws', { autoIteration: null }, 'explicit clear while running', 500);
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      summaryVersion: 1,
      autoIteration: { currentIteration: null, maxIterations: null, currentMetricSummary: null },
    });
  });

  it('keeps raw session busy distinct from loop working reason and rederives from accepted inputs', () => {
    const store = createStore();
    store.upsert(
      'ws',
      {
        ...authoritativeSnapshotInput(),
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        autoIteration: changedSnapshotInput().autoIteration,
      },
      'loop with idle runtime',
      100
    );
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      isWorking: false,
      statusReason: { code: 'AUTO_ITERATING' },
      kanbanColumn: 'WORKING',
    });
    store.upsert('ws', { isWorking: true }, 'runtime busy', 300);
    store.upsert(
      'ws',
      { isWorking: false, mode: 'STANDARD', autoIterationStatus: null, autoIteration: null },
      'stale runtime but current loop',
      200
    );
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      isWorking: true,
      kanbanColumn: 'WORKING',
      fieldTimestamps: { session: 300, autoIteration: 200 },
    });
    store.upsert('ws', { isWorking: false }, 'runtime idle', 400);
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      isWorking: false,
      statusReason: { code: 'NO_SESSION_STARTED' },
      kanbanColumn: 'WAITING',
    });
  });
});
