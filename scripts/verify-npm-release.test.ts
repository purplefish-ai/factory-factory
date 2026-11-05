import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const repository = 'purplefish-ai/factory-factory';
const commit = 'a'.repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff release verification '));
  roots.push(root);
  const artifact = join(root, 'artifacts');
  mkdirSync(artifact);
  mkdirSync(join(root, 'package'));
  writeFileSync(
    join(root, 'package/package.json'),
    JSON.stringify({ name: 'factory-factory', version: '1.2.3' })
  );
  const packed = spawnSync('tar', [
    '-czf',
    join(artifact, 'factory-factory-1.2.3.tgz'),
    '-C',
    root,
    'package',
  ]);
  expect(packed.status).toBe(0);
  const bytes = readFileSync(join(artifact, 'factory-factory-1.2.3.tgz'));
  const metadata = {
    name: 'factory-factory',
    version: '1.2.3',
    dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
  };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'pkg:npm/factory-factory@1.2.3',
        digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
      },
    ],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: `https://github.com/${repository}`,
            path: '.github/workflows/npm-publish.yml',
            ref: 'refs/heads/main',
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${repository}@refs/heads/main`,
            digest: { gitCommit: commit },
          },
        ],
      },
      runDetails: {
        metadata: { invocationId: `https://github.com/${repository}/actions/runs/123/attempts/1` },
      },
    },
  };
  mkdirSync(join(root, 'bin'));
  writeFileSync(
    join(root, 'bin/curl'),
    '#!/bin/sh\ncase "$*" in *attestations*) cat "$FIXTURE_ROOT/attestations.json" ;; *) cat "$FIXTURE_ROOT/metadata.json" ;; esac\n'
  );
  chmodSync(join(root, 'bin/curl'), 0o755);
  return {
    root,
    metadata,
    statement,
    artifact,
    run() {
      writeFileSync(join(root, 'metadata.json'), JSON.stringify(metadata));
      writeFileSync(
        join(root, 'attestations.json'),
        JSON.stringify({
          attestations: [
            {
              predicateType: 'https://slsa.dev/provenance/v1',
              bundle: {
                dsseEnvelope: {
                  payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
                },
              },
            },
          ],
        })
      );
      return spawnSync(
        'bash',
        [resolve('scripts/verify-npm-release.sh'), artifact, commit, '123', repository],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            FIXTURE_ROOT: root,
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          },
        }
      );
    },
  };
}

describe('published npm release identity', () => {
  it('accepts the staged bytes and provenance identity from the expected run', () => {
    const result = fixture().run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('1.2.3');
  });
  it.each(['sha512-invalid', 'sha256-AAAA', ''])('rejects invalid integrity %s', (integrity) => {
    const item = fixture();
    item.metadata.dist.integrity = integrity;
    expect(item.run().status).not.toBe(0);
  });
  it('rejects a different published version', () => {
    const item = fixture();
    item.metadata.version = '1.2.4';
    expect(item.run().status).not.toBe(0);
  });
  it.each([
    ['repository', 'https://github.com/other/repository'],
    ['ref', 'refs/heads/untrusted'],
  ] as const)('rejects provenance with a different workflow %s', (field, value) => {
    const item = fixture();
    item.statement.predicate.buildDefinition.externalParameters.workflow[field] = value;
    expect(item.run().status).not.toBe(0);
  });
  it('rejects a dependency URI outside the expected repository and main ref', () => {
    const item = fixture();
    item.statement.predicate.buildDefinition.resolvedDependencies[0]!.uri =
      'git+https://github.com/other/repository@refs/heads/main';
    expect(item.run().status).not.toBe(0);
  });
  it('passes the staged identity through the actual finalization workflow step', () => {
    const item = fixture();
    expect(item.run().status).toBe(0);
    const schema = z.object({
      jobs: z.object({
        'finalize-release': z.object({
          steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
        }),
      }),
    });
    const workflow = schema.parse(
      parse(readFileSync(resolve('.github/workflows/npm-publish.yml'), 'utf8'))
    );
    const command = workflow.jobs['finalize-release'].steps.find(
      (step) => step.name === 'Verify package is published on npm'
    )?.run;
    expect(command).toBeDefined();
    mkdirSync(join(item.root, 'scripts'));
    symlinkSync(
      resolve('scripts/verify-npm-release.sh'),
      join(item.root, 'scripts/verify-npm-release.sh')
    );
    symlinkSync(item.artifact, join(item.root, 'npm-package'));
    writeFileSync(join(item.root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const output = join(item.root, 'output');
    const result = spawnSync('bash', ['-c', command!], {
      cwd: item.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        STAGED_COMMIT: commit,
        STAGING_RUN_ID: '123',
        RELEASE_REPOSITORY: repository,
        GITHUB_OUTPUT: output,
        FIXTURE_ROOT: item.root,
        PATH: `${join(item.root, 'bin')}:${process.env.PATH}`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('version=1.2.3\n');
  });
  it('rejects provenance for another commit', () => {
    const item = fixture();
    item.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = 'b'.repeat(
      40
    );
    expect(item.run().status).not.toBe(0);
  });
  it('rejects provenance from another workflow', () => {
    const item = fixture();
    item.statement.predicate.buildDefinition.externalParameters.workflow.path =
      '.github/workflows/other.yml';
    expect(item.run().status).not.toBe(0);
  });
  it('rejects provenance from another staging run', () => {
    const item = fixture();
    item.statement.predicate.runDetails.metadata.invocationId = `https://github.com/${repository}/actions/runs/124/attempts/1`;
    expect(item.run().status).not.toBe(0);
  });
  it('rejects a provenance subject for different bytes', () => {
    const item = fixture();
    item.statement.subject[0]!.digest.sha512 = '0'.repeat(128);
    expect(item.run().status).not.toBe(0);
  });
  it('fails closed when the registry request times out', () => {
    const item = fixture();
    writeFileSync(join(item.root, 'bin/curl'), '#!/bin/sh\nexit 28\n');
    expect(item.run().status).not.toBe(0);
  });
  it('rejects ambiguous artifacts', () => {
    const item = fixture();
    writeFileSync(join(item.artifact, 'factory-factory-other.tgz'), 'other');
    expect(item.run().status).not.toBe(0);
  });
});

describe('release source ancestry', () => {
  it('accepts an older main release tag and rejects an off-main commit', () => {
    const schema = z.object({
      jobs: z.object({
        verify: z.object({
          steps: z.array(
            z.object({
              name: z.string().optional(),
              uses: z.string().optional(),
              with: z.object({ 'fetch-depth': z.number().optional() }).optional(),
              run: z.string().optional(),
            })
          ),
        }),
      }),
    });
    const workflow = schema.parse(
      parse(readFileSync(resolve('.github/workflows/npm-publish.yml'), 'utf8'))
    );
    expect(
      workflow.jobs.verify.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.[
        'fetch-depth'
      ]
    ).toBe(0);
    const command = workflow.jobs.verify.steps.find(
      (step) => step.name === 'Verify release source'
    )?.run;
    expect(command).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'ff release source '));
    roots.push(root);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    git('add', '.');
    git('commit', '-m', 'release');
    const release = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'later main commit');
    git('remote', 'add', 'origin', root);
    const run = (sha: string, ref = 'refs/tags/v1.2.3') =>
      spawnSync('bash', ['-c', command!], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, RELEASE_EVENT: 'release', RELEASE_REF: ref, RELEASE_COMMIT: sha },
      });
    expect(run(release).status).toBe(0);
    expect(run(release, 'refs/tags/v1.2.4').status).not.toBe(0);
    git('checkout', '-b', 'untrusted', release);
    git('commit', '--allow-empty', '-m', 'off main');
    expect(run(git('rev-parse', 'HEAD')).status).not.toBe(0);
  });
});
