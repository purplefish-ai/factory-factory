import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { selectJobs } from '../.github/scripts/select-ci.mjs';

const stepSchema = z.object({
  name: z.string().optional(),
  run: z.string().optional(),
});
const workflowSchema = z.object({
  concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }),
  jobs: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      if: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      steps: z.array(stepSchema).optional(),
      container: z.object({ image: z.string() }).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
  ),
});
const ci = workflowSchema.parse(parse(readFileSync('.github/workflows/ci.yml', 'utf8')));
const gates = ci.jobs['require-build'];
const gateCommand = z.string().parse(gates?.steps?.[0]?.run);

function runGate(selected: string, work: string, selection = 'success') {
  return spawnSync('bash', ['-e', '-c', gateCommand], {
    env: { SELECTION_RESULT: selection, SELECTED: selected, WORK_RESULT: work },
    encoding: 'utf8',
  }).status;
}

describe('conservative CI selection', () => {
  it('skips app work only for the explicit documentation allowlist', () => {
    expect(selectJobs('pull_request', ['README.md', 'docs/architecture/jobs.md'])).toEqual({
      app: false,
      storybook: false,
    });
  });

  it('runs application tests/build for backend-only changes but omits Storybook', () => {
    expect(selectJobs('pull_request', ['src/backend/service.ts', 'docs/testing.md'])).toEqual({
      app: true,
      storybook: false,
    });
  });

  it.each([
    'src/client/main.tsx',
    'src/components/ui/button.tsx',
    'src/shared/types.ts',
    'src/backend/styles.css',
    'prisma/schema.prisma',
    'package.json',
    'pnpm-lock.yaml',
    '.storybook/main.ts',
    'vitest.config.ts',
    '.github/workflows/ci.yml',
    '.github/scripts/select-ci.mjs',
    'prompts/agent.md',
    'AGENTS.md',
    'docs/CLAUDE.md',
    'docs/new-runtime.mdx',
    'unknown/path',
    'docs/file\nwith-newline.md',
  ])('runs everything for shared, config, runtime and unknown path %s', (file) => {
    expect(selectJobs('pull_request', ['docs/testing.md', file])).toEqual({
      app: true,
      storybook: true,
    });
  });

  it.each(['push', 'merge_group', 'schedule', 'workflow_dispatch'])('runs all on %s', (event) => {
    expect(selectJobs(event, ['README.md'])).toEqual({ app: true, storybook: true });
  });

  it('runs all for empty change lists', () => {
    expect(selectJobs('pull_request', [])).toEqual({ app: true, storybook: true });
  });

  it('includes deleted paths when a frontend file moves into backend', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-ci-selection-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git('init', '-q');
      git('config', 'user.name', 'CI test');
      git('config', 'user.email', 'ci@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      mkdirSync(join(directory, 'src/client'), { recursive: true });
      mkdirSync(join(directory, 'src/backend'), { recursive: true });
      writeFileSync(join(directory, 'README.md'), 'documentation');
      writeFileSync(join(directory, 'src/client/moved.ts'), 'export const moved = true;');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      // Same content would be detected as a rename without --no-renames.
      git('mv', 'src/client/moved.ts', 'src/backend/moved.ts');
      git('commit', '-qm', 'move');
      const script = resolve('.github/scripts/select-ci.mjs');
      const result = spawnSync(process.execPath, [script, 'pull_request', base], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('app=true\nstorybook=true\n');
      const failure = spawnSync(process.execPath, [script, 'pull_request', 'missing-base'], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(failure.status).not.toBe(0);
      expect(failure.stdout).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('required CI gates', () => {
  it('accepts successful selected work and explicitly omitted work', () => {
    expect(runGate('true', 'success')).toBe(0);
    expect(runGate('false', 'skipped')).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])('rejects failed selection: %s', (result) => {
    expect(runGate('false', 'skipped', result)).not.toBe(0);
  });

  it.each([
    ['true', 'failure'],
    ['true', 'cancelled'],
    ['true', 'skipped'],
    ['false', 'success'],
    ['false', 'failure'],
    ['', 'skipped'],
    ['invalid', 'success'],
  ])('rejects unexpected selection/work status %s/%s', (selected, work) => {
    expect(runGate(selected, work)).not.toBe(0);
  });

  it.each([
    ['build', 'Build'],
    ['storybook', 'Storybook Build'],
    ['storybook-tests', 'Storybook Tests'],
    ['test', 'Test'],
  ])('evaluates required %s independently of unrelated workers', (worker, name) => {
    const gate = ci.jobs[`require-${worker}`];
    expect(gate?.name).toBe(name);
    expect(gate?.if).toBe('always()');
    expect(gate?.needs).toEqual(['changes', worker]);
    expect(gate?.steps?.[0]?.run).toBe(gateCommand);
  });
});

it('pins the prebuilt Playwright image to the locked package version and a digest', () => {
  const lock = z
    .object({
      importers: z.object({
        '.': z.object({
          devDependencies: z.object({
            '@playwright/test': z.object({ version: z.string() }),
          }),
        }),
      }),
    })
    .parse(parse(readFileSync('pnpm-lock.yaml', 'utf8')));
  const version = lock.importers['.'].devDependencies['@playwright/test'].version;
  const storyTests = ci.jobs['storybook-tests'];
  expect(storyTests?.container?.image).toMatch(
    new RegExp(
      `^mcr.microsoft.com/playwright:v${version.replaceAll('.', '\\.')}-noble@sha256:[a-f0-9]{64}$`
    )
  );
  expect(storyTests?.env?.PLAYWRIGHT_IMAGE_VERSION).toBe(version);
  expect(storyTests?.env?.PLAYWRIGHT_BROWSERS_PATH).toBe('/ms-playwright');
  expect(storyTests?.steps?.some((step) => step.run?.includes('install --with-deps'))).toBe(false);
});

it('scopes supersession to each workflow and PR, keeping queues and schedules independent', () => {
  const codeql = workflowSchema.parse(parse(readFileSync('.github/workflows/codeql.yml', 'utf8')));
  for (const workflow of [ci, codeql]) {
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    expect(workflow.concurrency.group).toContain('github.workflow');
    expect(workflow.concurrency.group).toContain("github.event_name == 'pull_request'");
    expect(workflow.concurrency.group).toContain(
      "format('pr-{0}', github.event.pull_request.number)"
    );
    expect(workflow.concurrency.group).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.concurrency.group).toContain('|| github.run_id');
  }
});

it('installs only browser prerequisites in the compiler-free Storybook image', () => {
  const steps = ci.jobs['storybook-tests']?.steps ?? [];
  const install = steps.find((step) => step.name === 'Install browser-test dependencies');
  expect(install?.run).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  expect(install?.run).toContain('pnpm rebuild @prisma/engines esbuild');
  expect(steps.find((step) => step.name === 'Generate Prisma client')?.run).toBe(
    'pnpm db:generate'
  );
  for (const worker of ['build', 'storybook', 'test-shards', 'test']) {
    const install = ci.jobs[worker]?.steps?.find((step) => step.name === 'Install dependencies');
    expect(install?.run).toBe('pnpm install --frozen-lockfile');
  }
});
