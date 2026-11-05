import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const workflow = z
  .object({
    jobs: z.object({
      'build-mac': z.object({
        steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
      }),
      'create-release': z.object({
        steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
      }),
    }),
  })
  .parse(parse(readFileSync('.github/workflows/electron-release.yml', 'utf8')));
const guard = workflow.jobs['build-mac'].steps.find(
  (step) => step.name === 'Verify signed release source'
)?.run;
const directories: string[] = [];
// The guarded job runs on macOS; Windows does not require a Bash installation.
const sourceTest = it.skipIf(process.platform === 'win32');
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ff-desktop-source-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  git('add', 'package.json');
  git('commit', '-m', 'Release');
  const main = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', main);
  git('tag', 'v1.2.3');
  return {
    git,
    main,
    run(event: string, ref: string, sha = git('rev-parse', 'HEAD'), tag = 'v1.2.3') {
      if (!guard) {
        throw new Error('Signed release source guard is missing');
      }
      try {
        return execFileSync('bash', ['-c', guard], {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: event,
            GITHUB_REF: ref,
            GITHUB_SHA: sha,
            REQUESTED_RELEASE_TAG: tag,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const result = z.object({ stdout: z.string(), stderr: z.string() }).parse(error);
        throw new Error(result.stdout + result.stderr);
      }
    },
  };
}

sourceTest('accepts a signed manual build from main', () => {
  const repo = fixture();
  expect(() => repo.run('workflow_dispatch', 'refs/heads/main')).not.toThrow();
});

sourceTest('rejects signed manual builds from another branch even at a main commit', () => {
  const repo = fixture();
  expect(() => repo.run('workflow_dispatch', 'refs/heads/feature')).toThrow('main branch');
});

sourceTest('accepts a version-matching release tag on a main commit', () => {
  const repo = fixture();
  expect(() => repo.run('release', 'refs/tags/v1.2.3')).not.toThrow();
});

sourceTest('rejects a release tag that does not match the package version', () => {
  const repo = fixture();
  expect(() => repo.run('release', 'refs/tags/v9.9.9')).toThrow('package version');
});

sourceTest('rejects release commits outside main ancestry', () => {
  const repo = fixture();
  repo.git('checkout', '-b', 'feature');
  repo.git('commit', '--allow-empty', '-m', 'Unreviewed');
  expect(() => repo.run('release', 'refs/tags/v1.2.3')).toThrow('main ancestry');
});

sourceTest('rejects a checkout that differs from the event commit', () => {
  const repo = fixture();
  expect(() => repo.run('release', 'refs/tags/v1.2.3', '0'.repeat(40))).toThrow('event commit');
});

sourceTest('rejects a manual release tag that does not match the package version', () => {
  const repo = fixture();
  expect(() => repo.run('workflow_dispatch', 'refs/heads/main', repo.main, 'v9.9.9')).toThrow(
    'package version'
  );
});

sourceTest('rejects an empty manual release tag', () => {
  const repo = fixture();
  expect(() => repo.run('workflow_dispatch', 'refs/heads/main', repo.main, '')).toThrow(
    'package version'
  );
});

sourceTest('rejects an existing version tag that points to an older main commit', () => {
  const repo = fixture();
  repo.git('commit', '--allow-empty', '-m', 'Main advanced without a version change');
  const current = repo.git('rev-parse', 'HEAD');
  repo.git('update-ref', 'refs/remotes/origin/main', current);
  expect(() => repo.run('workflow_dispatch', 'refs/heads/main', current)).toThrow(
    'Existing release tag'
  );
});

function attachmentCheck(tagSha: string, queryFails = false) {
  const script = workflow.jobs['create-release'].steps.find(
    (step) => step.name === 'Verify release tag before attaching artifacts'
  )?.run;
  if (!script) {
    throw new Error('Attachment identity guard is missing');
  }
  return spawnSync(
    'bash',
    [
      '-c',
      `
    gh() {
      if [[ "$*" == *"matching-refs"* ]]; then return 0; fi
      if [[ "$*" == *" -X POST "* ]]; then return 1; fi
      if [ "$QUERY_FAILS" = true ]; then return 7; fi
      if [[ "$*" == *"/commits/refs/tags/"* ]]; then
        printf '%s\n' "$TAG_SHA"
      else
        # An unqualified ref may resolve to a same-named branch instead.
        printf '%s\n' "$GITHUB_SHA"
      fi
    }
    ${script}
  `,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'fixture/repository',
        GITHUB_SHA: 'a'.repeat(40),
        RELEASE_TAG: 'v1.2.3',
        TAG_SHA: tagSha,
        QUERY_FAILS: String(queryFails),
      },
    }
  );
}

sourceTest('permits attachment only when the remote tag resolves to the built source', () => {
  expect(attachmentCheck('a'.repeat(40)).status).toBe(0);
});

sourceTest('rejects a remote tag changed between build and attachment', () => {
  const result = attachmentCheck('b'.repeat(40));
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain('Release tag no longer matches');
});

sourceTest('rejects attachment when remote tag verification fails', () => {
  expect(attachmentCheck('a'.repeat(40), true).status).not.toBe(0);
});

it('disables native dependency rebuilds while signing credentials are present', () => {
  const signed = workflow.jobs['build-mac'].steps.find(
    (step) => step.name === 'Build signed and notarized release'
  );
  expect(signed?.run).toContain('--config.npmRebuild=false');
});
