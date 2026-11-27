import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKLOG_CUTOFF,
  type Backlog,
  gitEnvironment,
  mayCreate,
  provenanceSource,
  publishedVersions,
  type ReleaseEnvironment,
  type ReleaseRequest,
  releaseBody,
  releaseRequestBody,
  tagPublishedVersions,
} from './tag-npm-releases';

const repository = 'purplefish-ai/factory-factory';
// A distinct, valid 40-character commit for each test version.
const commitFor = (version: string) => version.replaceAll('.', '').padStart(40, 'c');
// A distinct staging run for each test version.
const runFor = (version: string) => `9${version.replaceAll('.', '')}`;

function statement(version: string, overrides: { commit?: string; run?: string } = {}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/factory-factory@${version}`, digest: { sha512: '0'.repeat(128) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/heads/main',
            repository: `https://github.com/${repository}`,
            path: '.github/workflows/npm-publish.yml',
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${repository}@refs/heads/main`,
            digest: { gitCommit: overrides.commit ?? commitFor(version) },
          },
        ],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: {
          invocationId: `https://github.com/${repository}/actions/runs/${overrides.run ?? '42'}/attempts/1`,
        },
      },
    },
  };
}

function bundle(payload: unknown, predicateType = 'https://slsa.dev/provenance/v1') {
  return {
    predicateType,
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
        payloadType: 'application/vnd.in-toto+json',
        signatures: [{ sig: 'signature', keyid: '' }],
      },
    },
  };
}

function attestations(...statements: unknown[]) {
  return {
    attestations: [
      bundle(
        { _type: 'https://in-toto.io/Statement/v1', predicateType: 'publish' },
        'https://github.com/npm/attestation/tree/main/specs/publish/v0.1'
      ),
      ...statements.map((item) => bundle(item)),
    ],
  };
}

describe('published versions', () => {
  it('orders stable versions numerically, oldest first, and names the latest dist-tag', () => {
    expect(
      publishedVersions({
        'dist-tags': { latest: '0.5.10', canary: '0.6.0-canary.1' },
        versions: { '0.5.10': {}, '0.4.12': {}, '0.5.9': {}, '0.6.0-canary.1': {}, '0.5.2': {} },
      })
    ).toEqual({ versions: ['0.4.12', '0.5.2', '0.5.9', '0.5.10'], latest: '0.5.10' });
  });

  it('rejects a registry document without versions', () => {
    expect(() => publishedVersions({ 'dist-tags': {} })).toThrow();
  });
});

describe('provenance source', () => {
  it('reads the commit and staging run from the SLSA statement for that version', () => {
    expect(provenanceSource(attestations(statement('1.2.3')), '1.2.3', repository)).toEqual({
      ok: true,
      commit: commitFor('1.2.3'),
      runId: '42',
    });
  });

  it('reports a version without attestations', () => {
    expect(provenanceSource(null, '1.2.3', repository)).toEqual({
      ok: false,
      reason: 'no provenance attestation on npm',
    });
  });

  const mutations: [string, (value: ReturnType<typeof statement>) => void][] = [
    [
      'another repository',
      (value) => {
        value.predicate.buildDefinition.externalParameters.workflow.repository =
          'https://github.com/someone/fork';
      },
    ],
    [
      'another workflow',
      (value) => {
        value.predicate.buildDefinition.externalParameters.workflow.path =
          '.github/workflows/other.yml';
      },
    ],
    [
      'another ref',
      (value) => {
        value.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/feature';
      },
    ],
    [
      'another source repository',
      (value) => {
        value.predicate.buildDefinition.resolvedDependencies[0]!.uri =
          'git+https://github.com/someone/fork@refs/heads/main';
      },
    ],
    [
      'contradictory source commits',
      (value) => {
        value.predicate.buildDefinition.resolvedDependencies.push({
          uri: `git+https://github.com/${repository}@refs/heads/main`,
          digest: { gitCommit: 'b'.repeat(40) },
        });
      },
    ],
    [
      'an abbreviated commit',
      (value) => {
        value.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = 'abc1234';
      },
    ],
    [
      'a run in another repository',
      (value) => {
        value.predicate.runDetails.metadata.invocationId =
          'https://github.com/someone/fork/actions/runs/42/attempts/1';
      },
    ],
    [
      'another package version',
      (value) => {
        value.subject[0]!.name = 'pkg:npm/factory-factory@1.2.4';
      },
    ],
  ];
  it.each(mutations)('skips provenance from %s', (_name, mutate) => {
    const value = statement('1.2.3');
    mutate(value);
    const result = provenanceSource(attestations(value), '1.2.3', repository);
    expect(result.ok).toBe(false);
  });

  it('skips a version with two provenance statements rather than choosing one', () => {
    const result = provenanceSource(
      attestations(statement('1.2.3'), statement('1.2.3', { commit: 'd'.repeat(40) })),
      '1.2.3',
      repository
    );
    expect(result).toEqual({ ok: false, reason: 'expected one provenance statement, found 2' });
  });

  it('skips a payload that is not the expected statement', () => {
    const result = provenanceSource(
      { attestations: [{ ...bundle({}), bundle: { dsseEnvelope: { payload: '!!' } } }] },
      '1.2.3',
      repository
    );
    expect(result.ok).toBe(false);
  });
});

describe('release body', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [1.2.10] - 2026-11-26',
    '',
    '### Fixed',
    '',
    '- Ten (#10)',
    '',
    '## [1.2.1] - 2026-11-23',
    '',
    '### Added',
    '',
    '- One (#1)',
    '',
  ].join('\n');

  it("uses that version's CHANGELOG section and names the npm version and commit", () => {
    expect(releaseBody(changelog, '1.2.1', 'a'.repeat(40))).toBe(
      `### Added\n\n- One (#1)\n\nPublished to npm as factory-factory@1.2.1, built from ${'a'.repeat(40)}.`
    );
    expect(releaseBody(changelog, '1.2.10', 'a'.repeat(40))).toContain('- Ten (#10)');
    expect(releaseBody(changelog, '1.2.10', 'a'.repeat(40))).not.toContain('One');
  });

  it('falls back to one line when the CHANGELOG has no section', () => {
    expect(releaseBody(changelog, '1.2.2', 'a'.repeat(40))).toBe(
      `Published to npm as factory-factory@1.2.2, built from ${'a'.repeat(40)}.`
    );
  });
});

function fakeEnvironment(options: {
  versions: string[];
  tags?: Record<string, string>;
  released?: string[];
  withoutAttestation?: string[];
  offMain?: string[];
  missing?: string[];
  manifestVersion?: Record<string, string>;
  unverified?: string[];
  latest?: string;
  /** Overrides of a version's staging run as GitHub reports it; null when it is gone. */
  runs?: Record<string, Record<string, unknown> | null>;
}) {
  const created: ReleaseRequest[] = [];
  const tagged: [string, string][] = [];
  const pauses: number[] = [];
  const verified: [string, string, string][] = [];
  const tags = new Map(Object.entries(options.tags ?? {}));
  const released = new Set(options.released);
  const latest = options.latest ?? options.versions.at(-1);
  const environment: ReleaseEnvironment = {
    packument: () =>
      Promise.resolve({
        'dist-tags': { latest },
        versions: Object.fromEntries(options.versions.map((version) => [version, {}])),
      }),
    attestations: (version) =>
      Promise.resolve(
        options.withoutAttestation?.includes(version)
          ? null
          : attestations(statement(version, { run: runFor(version) }))
      ),
    stagingRun: (runId) => {
      const version = options.versions.find((candidate) => runFor(candidate) === runId);
      const override = version === undefined ? null : options.runs?.[version];
      return Promise.resolve(
        version === undefined || override === null
          ? null
          : {
              id: Number(runId),
              path: '.github/workflows/npm-publish.yml',
              event: 'workflow_dispatch',
              head_branch: 'main',
              conclusion: 'success',
              head_sha: commitFor(version),
              ...override,
            }
      );
    },
    remoteTags: () => new Map(tags),
    releasedTags: () => new Set(released),
    mainHead: () => 'f'.repeat(40),
    commitExists: (commit) => !options.missing?.some((version) => commitFor(version) === commit),
    isAncestor: (commit) => !options.offMain?.some((version) => commitFor(version) === commit),
    packageJsonAt: (commit) => {
      const version =
        options.versions.find((candidate) => commitFor(candidate) === commit) ?? 'unknown';
      return JSON.stringify({
        name: 'factory-factory',
        version: options.manifestVersion?.[version] ?? version,
      });
    },
    verifyPublished: (version, commit, runId) => {
      verified.push([version, commit, runId]);
      return Promise.resolve(
        options.unverified?.includes(version)
          ? { ok: false, reason: 'Published npm package differs from the staged tarball' }
          : { ok: true }
      );
    },
    createTag: (tag, commit) => {
      tagged.push([tag, commit]);
      tags.set(tag, commit);
    },
    createRelease: (release) => {
      created.push(release);
      released.add(release.tag);
      if (!tags.has(release.tag)) {
        tags.set(release.tag, release.commit);
      }
    },
    pause: (milliseconds) => {
      pauses.push(milliseconds);
      return Promise.resolve();
    },
    changelog: '## [1.0.2] - 2026-11-01\n\n- Two\n',
  };
  return { environment, created, tagged, pauses, verified };
}

const run = (environment: ReleaseEnvironment, backlog: Backlog = 'none', dryRun = false) =>
  tagPublishedVersions(environment, { repository, dryRun, backlog });

describe('tagging published versions', () => {
  it('releases new versions oldest first and marks only the npm latest version as latest', async () => {
    const { environment, created, pauses, verified } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1', '1.0.2', '1.0.10'],
      tags: { 'v1.0.0': commitFor('1.0.0') },
    });
    const report = await run(environment);
    expect(created.map(({ tag, commit, latest }) => [tag, commit, latest])).toEqual([
      ['v1.0.1', commitFor('1.0.1'), false],
      ['v1.0.2', commitFor('1.0.2'), false],
      ['v1.0.10', commitFor('1.0.10'), true],
    ]);
    // The published bytes are verified against the commit and run the provenance names.
    expect(verified).toEqual([
      ['1.0.1', commitFor('1.0.1'), runFor('1.0.1')],
      ['1.0.2', commitFor('1.0.2'), runFor('1.0.2')],
      ['1.0.10', commitFor('1.0.10'), runFor('1.0.10')],
    ]);
    expect(created[1]?.body).toBe(
      `- Two\n\nPublished to npm as factory-factory@1.0.2, built from ${commitFor('1.0.2')}.`
    );
    expect(pauses).toHaveLength(2);
    expect(report.exitCode).toBe(0);
    expect(report.lines).toContain(`released v1.0.10 at ${commitFor('1.0.10')} (latest)`);
  });

  it('follows the npm latest dist-tag rather than the highest version', async () => {
    const { environment, created } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1', '1.1.0'],
      latest: '1.0.1',
    });
    await run(environment);
    expect(created.map(({ tag, latest }) => [tag, latest])).toEqual([
      ['v1.0.0', false],
      ['v1.0.1', true],
      ['v1.1.0', false],
    ]);
  });

  it('skips a version whose registry request fails and still releases the others', async () => {
    const { environment, created } = fakeEnvironment({ versions: ['1.0.0', '1.0.1'] });
    const attestationsFor = environment.attestations;
    environment.attestations = (version) =>
      version === '1.0.0' ? Promise.reject(new Error('HTTP 503')) : attestationsFor(version);
    const report = await run(environment);
    expect(created.map((release) => release.tag)).toEqual(['v1.0.1']);
    expect(report.exitCode).toBe(1);
    expect(report.lines[1]).toBe('skipped v1.0.0: could not check: HTTP 503');
  });

  it('creates nothing on a second run', async () => {
    const { environment, created } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1'],
      tags: { 'v1.0.0': commitFor('1.0.0') },
    });
    await run(environment);
    expect(created).toHaveLength(1);
    const second = await run(environment);
    expect(created).toHaveLength(1);
    expect(second).toEqual({ exitCode: 0, lines: ['mode: backlog none', 'nothing to create'] });
  });

  it('prints the mode and what it would do in a dry run, and creates nothing', async () => {
    const { environment, created } = fakeEnvironment({ versions: ['1.0.0', '1.0.1'] });
    const report = await run(environment, 'none', true);
    expect(created).toEqual([]);
    expect(report.lines).toEqual([
      'mode: backlog none, dry run',
      `would release v1.0.0 at ${commitFor('1.0.0')}`,
      `would release v1.0.1 at ${commitFor('1.0.1')} (latest)`,
      'would create 2 Releases and 2 tags',
    ]);
  });

  it('reports and skips versions it cannot verify, releases the rest and fails the run', async () => {
    const { environment, created } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.6'],
      withoutAttestation: ['1.0.0'],
      missing: ['1.0.1'],
      offMain: ['1.0.2'],
      manifestVersion: { '1.0.3': '1.0.2' },
      unverified: ['1.0.4'],
    });
    const report = await run(environment);
    expect(created.map((release) => release.tag)).toEqual(['v1.0.5', 'v1.0.6']);
    expect(report.exitCode).toBe(1);
    expect(report.lines.filter((line) => line.startsWith('skipped'))).toEqual([
      'skipped v1.0.0: no provenance attestation on npm',
      `skipped v1.0.1: commit ${commitFor('1.0.1')} is not in ${repository}`,
      `skipped v1.0.2: commit ${commitFor('1.0.2')} is not reachable from main`,
      `skipped v1.0.3: package.json at ${commitFor('1.0.3')} is version 1.0.2`,
      'skipped v1.0.4: Published npm package differs from the staged tarball',
    ]);
  });

  it('skips a version whose staging run GitHub does not confirm', async () => {
    const versions = ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.6', '1.0.7'];
    const { environment, created, verified } = fakeEnvironment({
      versions,
      runs: {
        '1.0.0': { head_sha: commitFor('1.0.7') },
        '1.0.1': { conclusion: 'cancelled' },
        '1.0.2': { event: 'push' },
        '1.0.3': { head_branch: 'feature' },
        '1.0.4': { path: '.github/workflows/other.yml' },
        '1.0.5': null,
        '1.0.6': { head_sha: 42 },
      },
    });
    const report = await run(environment);
    expect(created.map((release) => release.tag)).toEqual(['v1.0.7']);
    expect(verified.map(([version]) => version)).toEqual(['1.0.7']);
    expect(report.exitCode).toBe(1);
    expect(report.lines.filter((line) => line.startsWith('skipped'))).toEqual([
      `skipped v1.0.0: staging run ${runFor('1.0.0')} built ${commitFor('1.0.7')}, not ${commitFor('1.0.0')}`,
      `skipped v1.0.1: staging run ${runFor('1.0.1')} concluded cancelled, not success`,
      `skipped v1.0.2: staging run ${runFor('1.0.2')} was started by push, not workflow_dispatch`,
      `skipped v1.0.3: staging run ${runFor('1.0.3')} ran on feature, not main`,
      `skipped v1.0.4: staging run ${runFor('1.0.4')} ran .github/workflows/other.yml`,
      `skipped v1.0.5: staging run ${runFor('1.0.5')} is not on GitHub`,
      `skipped v1.0.6: staging run ${runFor('1.0.6')} is unreadable`,
    ]);
  });

  it('stops at the first failed release so later versions are not released out of order', async () => {
    const { environment } = fakeEnvironment({ versions: ['1.0.0', '1.0.1'] });
    const attempted: string[] = [];
    environment.createRelease = (release) => {
      attempted.push(release.tag);
      throw new Error('HTTP 403');
    };
    const report = await run(environment);
    expect(attempted).toEqual(['v1.0.0']);
    expect(report.exitCode).toBe(1);
    expect(report.lines.at(-1)).toBe('failed to release v1.0.0: HTTP 403');
  });
});

describe('the backlog', () => {
  // 0.5.14 is the cutoff; 0.5.15 is the first version released automatically.
  const versions = ['0.5.12', '0.5.13', '0.5.14'];

  it('is listed, not created, by a scheduled run, which succeeds', async () => {
    const { environment, created, tagged, verified } = fakeEnvironment({
      versions,
      tags: { 'v0.5.12': commitFor('0.5.12') },
    });
    expect(BACKLOG_CUTOFF).toBe('0.5.14');
    const report = await run(environment);
    expect(report).toEqual({
      exitCode: 0,
      lines: [
        'mode: backlog none',
        'backlog v0.5.13: not released automatically',
        'backlog v0.5.14: not released automatically',
        'nothing to create',
      ],
    });
    expect([created, tagged, verified]).toEqual([[], [], []]);
  });

  it('gets verified tags and no Releases in tags mode', async () => {
    const { environment, created, tagged, verified } = fakeEnvironment({
      versions,
      tags: { 'v0.5.12': commitFor('0.5.12') },
    });
    const report = await run(environment, 'tags');
    expect(tagged).toEqual([
      ['v0.5.13', commitFor('0.5.13')],
      ['v0.5.14', commitFor('0.5.14')],
    ]);
    expect(created).toEqual([]);
    expect(verified.map(([version]) => version)).toEqual(['0.5.13', '0.5.14']);
    expect(report.lines).toEqual([
      'mode: backlog tags',
      `tagged v0.5.13 at ${commitFor('0.5.13')}`,
      `tagged v0.5.14 at ${commitFor('0.5.14')}`,
    ]);
  });

  it('gets the missing Releases in releases mode after tags mode, without error', async () => {
    const { environment, created, tagged } = fakeEnvironment({ versions });
    await run(environment, 'tags');
    expect(tagged).toHaveLength(3);
    const report = await run(environment, 'releases');
    expect(report.exitCode).toBe(0);
    expect(created.map(({ tag, latest }) => [tag, latest])).toEqual([
      ['v0.5.12', false],
      ['v0.5.13', false],
      ['v0.5.14', true],
    ]);
    expect(report.lines.at(-1)).toBe(
      `released v0.5.14 at ${commitFor('0.5.14')} (existing tag) (latest)`
    );
    expect(await run(environment, 'releases')).toEqual({
      exitCode: 0,
      lines: ['mode: backlog releases', 'nothing to create'],
    });
  });

  it('restores the tag of a Release whose tag was deleted, in releases mode', async () => {
    const { environment, created, tagged } = fakeEnvironment({
      versions,
      tags: { 'v0.5.12': commitFor('0.5.12'), 'v0.5.14': commitFor('0.5.14') },
      released: ['v0.5.12', 'v0.5.13', 'v0.5.14'],
    });
    const report = await run(environment, 'releases');
    expect(tagged).toEqual([['v0.5.13', commitFor('0.5.13')]]);
    expect(created).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('skips a Release for a tag that points at another commit', async () => {
    const { environment, created } = fakeEnvironment({
      versions,
      tags: { 'v0.5.13': 'd'.repeat(40) },
      released: ['v0.5.12'],
    });
    const report = await run(environment, 'releases');
    expect(created.map((release) => release.tag)).toEqual(['v0.5.14']);
    expect(report.exitCode).toBe(1);
    expect(report.lines).toContain(
      `skipped v0.5.13: tag v0.5.13 points at ${'d'.repeat(40)}, not ${commitFor('0.5.13')}`
    );
  });

  it.each(['none', 'tags', 'releases'] as const)(
    'does not hold back a version above the cutoff in %s mode',
    async (backlog) => {
      const { environment, created } = fakeEnvironment({
        versions: ['0.5.14', '0.5.15'],
        tags: { 'v0.5.14': commitFor('0.5.14') },
        released: ['v0.5.14'],
      });
      const report = await run(environment, backlog);
      expect(created.map(({ tag, latest }) => [tag, latest])).toEqual([['v0.5.15', true]]);
      expect(report.exitCode).toBe(0);
    }
  );

  it('ends a dry run with nothing to do with a zero count', async () => {
    const { environment } = fakeEnvironment({ versions: ['0.5.14'] });
    expect((await run(environment, 'none', true)).lines).toEqual([
      'mode: backlog none, dry run',
      'backlog v0.5.14: not released automatically',
      'nothing to create',
      'would create 0 Releases and 0 tags',
    ]);
  });

  it.each([
    ['tags', 'would tag v0.5.14 at', 'would create 0 Releases and 1 tags'],
    ['releases', 'would release v0.5.14 at', 'would create 2 Releases and 1 tags'],
  ] as const)(
    'names %s mode and counts what it would create in a dry run',
    async (backlog, action, count) => {
      // v0.5.13 is already tagged at its commit, without a Release.
      const { environment, created, tagged } = fakeEnvironment({
        versions: ['0.5.13', '0.5.14'],
        tags: { 'v0.5.13': commitFor('0.5.13') },
      });
      const report = await run(environment, backlog, true);
      expect(report.lines[0]).toBe(`mode: backlog ${backlog}, dry run`);
      expect(report.lines.some((line) => line.startsWith(action))).toBe(true);
      expect(report.lines.at(-1)).toBe(count);
      expect([created, tagged]).toEqual([[], []]);
    }
  );
});

describe('creating on GitHub', () => {
  const release = {
    tag: 'v1.2.3',
    commit: 'a'.repeat(40),
    name: 'v1.2.3',
    body: 'Notes',
    latest: false,
  };

  it('sends make_latest as the string false for every Release but the npm latest', () => {
    // GitHub marks a new release latest when make_latest is absent.
    expect(releaseRequestBody(release)).toEqual({
      tag_name: 'v1.2.3',
      target_commitish: 'a'.repeat(40),
      name: 'v1.2.3',
      body: 'Notes',
      draft: false,
      prerelease: false,
      make_latest: 'false',
    });
    expect(releaseRequestBody({ ...release, latest: true }).make_latest).toBe('true');
  });

  it('refuses to create anything outside GitHub Actions without the named override', () => {
    const script = resolve('scripts/tag-npm-releases.ts');
    const environment = { ...process.env, GITHUB_ACTIONS: '' };
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, '--repository', 'owner/name', '--backlog', 'releases'],
      { encoding: 'utf8', env: environment }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('refusing to create tags or Releases outside GitHub Actions');
    expect(mayCreate({ dryRun: true, inActions: false, override: false })).toBe(true);
    expect(mayCreate({ dryRun: false, inActions: true, override: false })).toBe(true);
    expect(mayCreate({ dryRun: false, inActions: false, override: true })).toBe(true);
    expect(mayCreate({ dryRun: false, inActions: false, override: false })).toBe(false);
  });
});

describe('git checks', () => {
  const roots: string[] = [];
  afterEach(() =>
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  );

  it('reads tags, main ancestry, commit existence and the manifest at a commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff release tags '));
    roots.push(root);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    git('add', '.');
    git('commit', '-qm', 'release');
    const release = git('rev-parse', 'HEAD');
    git('tag', '-a', 'v1.2.2', '-m', 'annotated');
    git('tag', 'v1.2.1');
    git('commit', '-q', '--allow-empty', '-m', 'later');
    git('switch', '-qc', 'untrusted', release);
    git('commit', '-q', '--allow-empty', '-m', 'off main');
    const offMain = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    git('remote', 'add', 'origin', root);

    const environment = gitEnvironment(root);
    // The annotated tag resolves to its commit, not to the tag object.
    expect(Object.fromEntries(environment.remoteTags())).toEqual({
      'v1.2.1': release,
      'v1.2.2': release,
    });
    const head = environment.mainHead();
    expect(head).toBe(git('rev-parse', 'main'));
    expect(environment.isAncestor(release, head)).toBe(true);
    expect(environment.isAncestor(offMain, head)).toBe(false);
    expect(environment.commitExists(release)).toBe(true);
    expect(environment.commitExists('0'.repeat(40))).toBe(false);
    expect(environment.packageJsonAt(release)).toBe(JSON.stringify({ version: '1.2.3' }));
  });
});
