import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitEnvironment,
  provenanceSource,
  publishedVersions,
  type ReleaseEnvironment,
  type ReleaseRequest,
  releaseBody,
  tagPublishedVersions,
} from './tag-npm-releases';

const repository = 'purplefish-ai/factory-factory';
// A distinct, valid 40-character commit for each test version.
const commitFor = (version: string) => version.replaceAll('.', '').padStart(40, 'c');

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
  tags: string[];
  withoutAttestation?: string[];
  offMain?: string[];
  missing?: string[];
  manifestVersion?: Record<string, string>;
  unverified?: string[];
  latest?: string;
}) {
  const created: ReleaseRequest[] = [];
  const pauses: number[] = [];
  const verified: [string, string, string][] = [];
  const tags = new Set(options.tags);
  const latest = options.latest ?? options.versions.at(-1);
  const environment: ReleaseEnvironment = {
    packument: () =>
      Promise.resolve({
        'dist-tags': { latest },
        versions: Object.fromEntries(options.versions.map((version) => [version, {}])),
      }),
    attestations: (version) =>
      Promise.resolve(
        options.withoutAttestation?.includes(version) ? null : attestations(statement(version))
      ),
    remoteTags: () => new Set(tags),
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
    createRelease: (release) => {
      created.push(release);
      tags.add(release.tag);
    },
    pause: (milliseconds) => {
      pauses.push(milliseconds);
      return Promise.resolve();
    },
    changelog: '## [1.0.2] - 2026-11-01\n\n- Two\n',
  };
  return { environment, created, pauses, verified };
}

describe('tagging published versions', () => {
  it('releases the backlog oldest first and marks only the npm latest version as latest', async () => {
    const { environment, created, pauses, verified } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1', '1.0.2', '1.0.10'],
      tags: ['v1.0.0'],
    });
    const report = await tagPublishedVersions(environment, { repository, dryRun: false });
    expect(created.map(({ tag, commit, latest }) => [tag, commit, latest])).toEqual([
      ['v1.0.1', commitFor('1.0.1'), false],
      ['v1.0.2', commitFor('1.0.2'), false],
      ['v1.0.10', commitFor('1.0.10'), true],
    ]);
    // The published bytes are verified against the commit and run the provenance names.
    expect(verified).toEqual([
      ['1.0.1', commitFor('1.0.1'), '42'],
      ['1.0.2', commitFor('1.0.2'), '42'],
      ['1.0.10', commitFor('1.0.10'), '42'],
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
      tags: [],
      latest: '1.0.1',
    });
    await tagPublishedVersions(environment, { repository, dryRun: false });
    expect(created.map(({ tag, latest }) => [tag, latest])).toEqual([
      ['v1.0.0', false],
      ['v1.0.1', true],
      ['v1.1.0', false],
    ]);
  });

  it('skips a version whose registry request fails and still releases the others', async () => {
    const { environment, created } = fakeEnvironment({ versions: ['1.0.0', '1.0.1'], tags: [] });
    const attestationsFor = environment.attestations;
    environment.attestations = (version) =>
      version === '1.0.0' ? Promise.reject(new Error('HTTP 503')) : attestationsFor(version);
    const report = await tagPublishedVersions(environment, { repository, dryRun: false });
    expect(created.map((release) => release.tag)).toEqual(['v1.0.1']);
    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toBe('skipped v1.0.0: could not check: HTTP 503');
  });

  it('creates nothing on a second run', async () => {
    const { environment, created } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1'],
      tags: ['v1.0.0'],
    });
    await tagPublishedVersions(environment, { repository, dryRun: false });
    expect(created).toHaveLength(1);
    const second = await tagPublishedVersions(environment, { repository, dryRun: false });
    expect(created).toHaveLength(1);
    expect(second).toEqual({ exitCode: 0, lines: ['every published version is tagged'] });
  });

  it('prints what it would do in a dry run and creates nothing', async () => {
    const { environment, created } = fakeEnvironment({ versions: ['1.0.0', '1.0.1'], tags: [] });
    const report = await tagPublishedVersions(environment, { repository, dryRun: true });
    expect(created).toEqual([]);
    expect(report.lines).toEqual([
      `would release v1.0.0 at ${commitFor('1.0.0')}`,
      `would release v1.0.1 at ${commitFor('1.0.1')} (latest)`,
    ]);
  });

  it('reports and skips versions it cannot verify, releases the rest and fails the run', async () => {
    const { environment, created } = fakeEnvironment({
      versions: ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.6'],
      tags: [],
      withoutAttestation: ['1.0.0'],
      missing: ['1.0.1'],
      offMain: ['1.0.2'],
      manifestVersion: { '1.0.3': '1.0.2' },
      unverified: ['1.0.4'],
    });
    const report = await tagPublishedVersions(environment, { repository, dryRun: false });
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

  it('stops at the first failed release so later versions are not released out of order', async () => {
    const { environment } = fakeEnvironment({ versions: ['1.0.0', '1.0.1'], tags: [] });
    const attempted: string[] = [];
    environment.createRelease = (release) => {
      attempted.push(release.tag);
      throw new Error('HTTP 403');
    };
    const report = await tagPublishedVersions(environment, { repository, dryRun: false });
    expect(attempted).toEqual(['v1.0.0']);
    expect(report.exitCode).toBe(1);
    expect(report.lines.at(-1)).toBe('failed to release v1.0.0: HTTP 403');
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
    expect([...environment.remoteTags()].toSorted()).toEqual(['v1.2.1', 'v1.2.2']);
    const head = environment.mainHead();
    expect(head).toBe(git('rev-parse', 'main'));
    expect(environment.isAncestor(release, head)).toBe(true);
    expect(environment.isAncestor(offMain, head)).toBe(false);
    expect(environment.commitExists(release)).toBe(true);
    expect(environment.commitExists('0'.repeat(40))).toBe(false);
    expect(environment.packageJsonAt(release)).toBe(JSON.stringify({ version: '1.2.3' }));
  });
});
