import { describe, expect, it } from 'vitest';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import {
  authoritativeSnapshotInput,
  changedSnapshotInput,
  snapshotFieldPolicy,
  snapshotInputFields,
} from '@/test-utils/workspace-snapshot-contract';
import { detectDrift } from './snapshot-reconciliation.orchestrator';

const existing = makeWorkspaceSnapshotEntry({ ...authoritativeSnapshotInput() });

describe('raw snapshot drift contract', () => {
  it.each(snapshotInputFields)('%s is compared or deliberately excluded', (field) => {
    const { drift } = snapshotFieldPolicy[field];
    const authoritativeValue = changedSnapshotInput()[field];
    expect(detectDrift(existing, { [field]: authoritativeValue })).toEqual(
      typeof drift === 'string'
        ? [
            {
              field,
              group: drift,
              snapshotValue: existing[field as keyof typeof existing],
              authoritativeValue,
            },
          ]
        : []
    );
  });

  it.each(['prs', 'sessionSummaries'] as const)(
    '%s ignores order in both drift and publication but detects nested changes',
    (field) => {
      const store = new WorkspaceSnapshotStore();
      store.configure({
        deriveFlowState: (input) =>
          deriveWorkspaceFlowState({
            ...input,
            prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
          }),
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      });
      try {
        const changed = changedSnapshotInput();
        const first = field === 'prs' ? changed.prs[0]! : changed.sessionSummaries[0]!;
        const second =
          field === 'prs'
            ? { ...changed.prs[0]!, id: 'pr-2' }
            : { ...changed.sessionSummaries[0]!, sessionId: 'session-2' };
        store.upsert(
          'ws',
          { ...authoritativeSnapshotInput(), [field]: [first, second] },
          'authoritative',
          100
        );
        const entry = store.getByWorkspaceId('ws')!;
        const reordered = { [field]: [structuredClone(second), structuredClone(first)] };
        expect(detectDrift(entry, reordered)).toEqual([]);
        expect(store.upsert('ws', reordered, 'reordered', 200)).toEqual({
          accepted: true,
          changed: false,
          emitted: false,
        });
        const edited =
          field === 'prs'
            ? { ...first, title: 'Changed title' }
            : { ...first, name: 'Changed session' };
        const nestedChange = { [field]: [second, edited] };
        expect(detectDrift(entry, nestedChange).map((drift) => drift.field)).toEqual([field]);
        expect(store.upsert('ws', nestedChange, 'nested change', 300)).toEqual({
          accepted: true,
          changed: true,
          emitted: true,
        });
      } finally {
        store.clear();
      }
    }
  );
});
