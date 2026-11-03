import { describe, expect, it } from 'vitest';
import {
  CIStatus,
  deriveCiStatusFromCheckRollup,
  deriveRatchetState,
  deriveWorkspaceSidebarStatus,
  PRState,
} from '@/shared/core';
import { mapStatusChecks } from './mappers';
import { fullPRDetailsSchema } from './schemas';

describe('legacy StatusContext rerun normalization', () => {
  it.each([
    ['SUCCESS', CIStatus.SUCCESS],
    ['FAILURE', CIStatus.FAILURE],
    ['PENDING', CIStatus.PENDING],
    ['EXPECTED', CIStatus.PENDING],
  ])('classifies the latest Actions attempt with state %s', (state, expected) => {
    const rollup = [
      {
        __typename: 'StatusContext',
        context: 'ci/build',
        state: 'FAILURE',
        targetUrl: 'https://github.com/owner/repo/actions/runs/1',
      },
      {
        __typename: 'StatusContext',
        context: 'ci/build',
        state,
        targetUrl: 'https://github.com/owner/repo/actions/runs/2',
      },
    ];
    const ciStatus = deriveCiStatusFromCheckRollup(
      mapStatusChecks(fullPRDetailsSchema.shape.statusCheckRollup.parse(rollup) ?? [])
    );
    expect(ciStatus).toBe(expected);
  });

  it('retains failures for legacy contexts without Actions run identity', () => {
    const rollup = [
      { context: 'ci/build', state: 'FAILURE', targetUrl: 'https://ci.example/jobs/1' },
      { context: 'ci/build', state: 'SUCCESS', targetUrl: 'https://ci.example/jobs/2' },
    ];
    expect(
      deriveCiStatusFromCheckRollup(
        mapStatusChecks(fullPRDetailsSchema.shape.statusCheckRollup.parse(rollup) ?? [])
      )
    ).toBe(CIStatus.FAILURE);
  });
});

describe('STARTUP_FAILURE check rollups', () => {
  it.each(['STARTUP_FAILURE', 'startup_failure'])(
    'preserves %s as a terminal failure',
    (conclusion) => {
      const checks = mapStatusChecks([{ name: 'ci', status: 'completed', conclusion }]);

      expect(checks[0]?.conclusion).toBe('STARTUP_FAILURE');
      expect(deriveCiStatusFromCheckRollup(checks)).toBe(CIStatus.FAILURE);
    }
  );

  it.each(['SUCCESS', null])(
    'keeps the sidebar state failing alongside conclusion %s',
    (otherConclusion) => {
      const rollup = [
        { name: 'startup', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
        {
          name: 'build',
          status: otherConclusion ? 'COMPLETED' : 'IN_PROGRESS',
          ...(otherConclusion ? { conclusion: otherConclusion } : {}),
        },
      ];
      const prCiStatus = deriveCiStatusFromCheckRollup(mapStatusChecks(rollup));

      expect(prCiStatus).toBe(CIStatus.FAILURE);
      const ratchetState = deriveRatchetState({
        ratchetEnabled: true,
        prState: PRState.OPEN,
        prCiStatus,
        prHasMergeConflict: false,
        prReviewState: null,
      });
      expect(
        deriveWorkspaceSidebarStatus({
          isWorking: false,
          prUrl: 'https://github.com/owner/repo/pull/123',
          prState: PRState.OPEN,
          prCiStatus,
          ratchetState,
        }).ciState
      ).toBe('FAILING');
    }
  );
});
