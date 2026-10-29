import type { ExportData } from '@/shared/schemas/export-data.schema';

function omitFields(value: object, fields: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
}

/** Reconstruct the published wire shapes, rather than relabeling a v6 export. */
export function createLegacyLoopBackup(exported: ExportData, schemaVersion: 4 | 5 | 6) {
  return {
    ...exported,
    meta: { ...exported.meta, schemaVersion },
    data: {
      ...exported.data,
      agentSessions: exported.data.agentSessions.map((session) => ({
        ...session,
        workflow: 'auto-iteration',
        workspacePrId: schemaVersion === 5 ? 'pr1' : null,
      })),
      workspaces: exported.data.workspaces.map((workspace) => {
        const loop = {
          mode: 'AUTO_ITERATION',
          autoIterationConfig: { testCommand: 'pnpm test', targetDescription: 'coverage' },
          autoIterationStatus: 'RUNNING',
          autoIterationProgress: { currentIteration: 2 },
          autoIterationSessionId: 'session-1',
        };
        if (schemaVersion === 6) {
          return { ...workspace, ...loop };
        }
        const legacy = {
          ...omitFields(workspace, ['prMonitoring', 'prEvents', 'prDiscovery', 'prs']),
          ...loop,
          ratchetActiveSessionId: 'session-1',
        };
        if (schemaVersion === 4) {
          return legacy;
        }
        return {
          ...omitFields(legacy, [
            'prUrl',
            'prNumber',
            'prState',
            'prReviewState',
            'prCiStatus',
            'prUpdatedAt',
            'prCiFailedAt',
            'prCiLastNotifiedAt',
            'prReviewLastCheckedAt',
            'prReviewLastCommentId',
            'ratchetLastCiRunId',
            'ratchetState',
          ]),
          ratchetActivePrId: 'pr1',
          prs: workspace.prs.map((pr) => ({
            ...omitFields(pr, [
              'dedicatedSession',
              'observation',
              'observationEpoch',
              'transitionSequence',
            ]),
            ratchet: {
              lastCheckedAt: '2025-01-01T00:25:00.000Z',
              activeSessionId: 'session-1',
              dispatchSnapshotKey: 'legacy-ci-run',
              dispatchOutcome: 'RUNNING',
              dispatchRetryCount: 2,
              dispatchStalled: false,
            },
          })),
        };
      }),
      userSettings: { ...exported.data.userSettings, autoIterationPermissions: 'YOLO' },
    },
  };
}
