import { describe, expect, it } from 'vitest';
import type { GitHubStatusCheck } from '@/shared/github-types';
import { normalizeGitHubCheckFacts } from './github-check-facts';
import { mapStatusChecks } from './github-cli/mappers';

const failedCheck: GitHubStatusCheck = {
  __typename: 'CheckRun',
  name: 'test',
  workflowName: 'CI',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/org/repo/actions/runs/1/job/10',
  startedAt: '2026-10-27T09:00:00-04:00',
  completedAt: '2026-10-27T09:01:00-04:00',
};

describe('normalizeGitHubCheckFacts', () => {
  it.each([
    { rollup: null, ciStatus: 'UNKNOWN' },
    { rollup: [], ciStatus: 'SUCCESS' },
  ])('distinguishes missing and empty rollups: $ciStatus', ({ rollup, ciStatus }) => {
    expect(normalizeGitHubCheckFacts(rollup)).toEqual({ checks: [], ciStatus });
  });

  it('preserves failure-signature fields and normalizes timestamps', () => {
    expect(normalizeGitHubCheckFacts([failedCheck])).toEqual({
      ciStatus: 'FAILURE',
      checks: [
        {
          identity: 'https://github.com/org/repo/actions/runs/1/job/10',
          attempt: null,
          name: 'test',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/org/repo/actions/runs/1/job/10',
          startedAt: '2026-10-27T13:00:00.000Z',
          completedAt: '2026-10-27T13:01:00.000Z',
        },
      ],
    });
  });

  it('uses workflow and check names without a URL and clears invalid timestamps', () => {
    expect(
      normalizeGitHubCheckFacts([
        {
          ...failedCheck,
          detailsUrl: '',
          startedAt: 'invalid',
          completedAt: '',
        },
        { __typename: 'StatusContext', name: 'legacy', status: 'PENDING', conclusion: null },
      ])
    ).toEqual({
      ciStatus: 'FAILURE',
      checks: [
        {
          identity: 'CI:test',
          attempt: null,
          name: 'test',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
        },
        {
          identity: ':legacy',
          attempt: null,
          name: 'legacy',
          workflowName: null,
          status: 'PENDING',
          conclusion: null,
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    });
  });

  it.each(['STARTUP_FAILURE', 'startup_failure'])(
    'preserves mapped CheckRun and StatusContext facts for %s',
    (conclusion) => {
      const rollup = mapStatusChecks([
        { name: 'startup', status: 'completed', conclusion },
        {
          __typename: 'StatusContext',
          context: 'external',
          state: 'error',
          targetUrl: 'https://ci.example/jobs/1',
        },
      ]);
      expect(normalizeGitHubCheckFacts(rollup)).toEqual({
        ciStatus: 'FAILURE',
        checks: [
          {
            identity: ':startup',
            attempt: null,
            name: 'startup',
            workflowName: null,
            status: 'COMPLETED',
            conclusion: 'STARTUP_FAILURE',
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
          },
          {
            identity: 'https://ci.example/jobs/1',
            attempt: null,
            name: 'external',
            workflowName: null,
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://ci.example/jobs/1',
            startedAt: null,
            completedAt: null,
          },
        ],
      });
    }
  );

  it('selects the newest run before timestamps while preserving distinct workflow and check identities', () => {
    const rollup: GitHubStatusCheck[] = [
      failedCheck,
      {
        ...failedCheck,
        name: ' TEST ',
        workflowName: 'ci',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/org/repo/actions/runs/2/job/20',
        startedAt: '2026-10-26T09:00:00Z',
        completedAt: '2026-10-26T09:01:00Z',
      },
      { ...failedCheck, workflowName: 'Release' },
      { ...failedCheck, name: 'build' },
    ];
    const result = normalizeGitHubCheckFacts(rollup);
    expect(result.ciStatus).toBe('FAILURE');
    expect(
      result.checks.map(({ identity, name, workflowName, conclusion }) => ({
        identity,
        name,
        workflowName,
        conclusion,
      }))
    ).toEqual([
      {
        identity: 'https://github.com/org/repo/actions/runs/2/job/20',
        name: ' TEST ',
        workflowName: 'ci',
        conclusion: 'SUCCESS',
      },
      {
        identity: 'https://github.com/org/repo/actions/runs/1/job/10',
        name: 'test',
        workflowName: 'Release',
        conclusion: 'FAILURE',
      },
      {
        identity: 'https://github.com/org/repo/actions/runs/1/job/10',
        name: 'build',
        workflowName: 'CI',
        conclusion: 'FAILURE',
      },
    ]);
    expect(rollup[0]).toBe(failedCheck);
    expect(rollup).toHaveLength(4);
  });

  it('uses the latest timestamp for reruns of the same Actions run', () => {
    const result = normalizeGitHubCheckFacts([
      failedCheck,
      { ...failedCheck, conclusion: 'SUCCESS', completedAt: '2026-10-27T15:00:00Z' },
    ]);
    expect(result.ciStatus).toBe('SUCCESS');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      attempt: null,
      conclusion: 'SUCCESS',
      completedAt: '2026-10-27T15:00:00.000Z',
    });
  });

  it('reduces legacy Actions contexts while retaining failures from unrelated external checks', () => {
    const result = normalizeGitHubCheckFacts(
      mapStatusChecks([
        {
          context: 'legacy',
          state: 'failure',
          targetUrl: 'https://github.com/org/repo/actions/runs/1',
        },
        {
          context: 'legacy',
          state: 'success',
          targetUrl: 'https://github.com/org/repo/actions/runs/2',
        },
        { context: 'external', state: 'failure', targetUrl: 'https://ci.example/jobs/1' },
        { context: 'external', state: 'success', targetUrl: 'https://ci.example/jobs/2' },
      ])
    );
    expect(result.ciStatus).toBe('FAILURE');
    expect(result.checks.map(({ identity, conclusion }) => ({ identity, conclusion }))).toEqual([
      { identity: 'https://github.com/org/repo/actions/runs/2', conclusion: 'SUCCESS' },
      { identity: 'https://ci.example/jobs/1', conclusion: 'FAILURE' },
      { identity: 'https://ci.example/jobs/2', conclusion: 'SUCCESS' },
    ]);
  });
});
