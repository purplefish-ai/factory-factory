import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { selectJobs } from '../.github/scripts/select-ci.mjs';

const stepSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
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
      outputs: z.record(z.string(), z.string()).optional(),
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
  it('tests, builds and exercises native modules on the separate user minimum', () => {
    const job = ci.jobs['minimum-node'];
    expect(job?.needs).toBe('changes');
    expect(job?.if).toBe("needs.changes.outputs.app == 'true'");
    const setup = job?.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setup?.with?.['node-version-file']).toBe('.node-minimum');
    const commands = job?.steps
      ?.map((step) => step.run)
      .filter(Boolean)
      .join('\n');
    expect(commands).toContain('pnpm test');
    expect(commands).toContain('pnpm build');
    expect(commands).toContain('node dist/src/cli/bootstrap.mjs serve --help');
    expect(commands).toContain('node dist/src/cli/bootstrap.mjs db:migrate');
    expect(commands).toContain('node scripts/check-installed-native-runtime.mjs');
  });

  it('skips app work only for the explicit documentation allowlist', () => {
    expect(selectJobs('pull_request', ['README.md', 'docs/architecture/jobs.md'])).toEqual({
      app: false,
      storybook: false,
      sandbox: false,
    });
  });

  it('runs application tests/build for backend-only changes but omits Storybook', () => {
    expect(selectJobs('pull_request', ['src/backend/service.ts', 'docs/testing.md'])).toEqual({
      app: true,
      storybook: false,
      sandbox: true,
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
      sandbox: true,
    });
  });

  it.each(['push', 'merge_group', 'schedule', 'workflow_dispatch'])('runs all on %s', (event) => {
    expect(selectJobs(event, ['README.md'])).toEqual({ app: true, storybook: true, sandbox: true });
  });

  it('runs all for empty change lists', () => {
    expect(selectJobs('pull_request', [])).toEqual({ app: true, storybook: true, sandbox: true });
  });

  it.each(['rename', 'documentation'])(
    'selects the actual shallow merge diff when main advances (%s)',
    (change) => {
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
        git('switch', '-qc', 'pr-change');
        if (change === 'rename') {
          // Same content would be detected as a rename without --no-renames.
          git('mv', 'src/client/moved.ts', 'src/backend/moved.ts');
        } else {
          writeFileSync(join(directory, 'README.md'), 'updated documentation');
          git('add', '.');
        }
        git('commit', '-qm', 'PR change');
        git('switch', '-qc', 'advanced-main', base);
        writeFileSync(join(directory, 'main-only-config.ts'), 'export const mainChange = true;');
        git('add', '.');
        git('commit', '-qm', 'base advances after event');
        git('merge', '--no-ff', 'pr-change', '-m', 'integrated PR');
        const shallow = join(directory, 'shallow');
        git('clone', '--quiet', '--depth=2', `file://${directory}`, shallow);
        // The stale event base is not among the regenerated merge's shallow parents.
        expect(spawnSync('git', ['cat-file', '-e', base], { cwd: shallow }).status).not.toBe(0);
        const script = resolve('.github/scripts/select-ci.mjs');
        const result = spawnSync(process.execPath, [script, 'pull_request'], {
          cwd: shallow,
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(
          change === 'rename'
            ? 'app=true\nstorybook=true\nsandbox=true\n'
            : 'app=false\nstorybook=false\nsandbox=false\n'
        );
        // A non-merge checkout cannot safely represent the whole integrated PR.
        git('switch', 'pr-change');
        const failure = spawnSync(process.execPath, [script, 'pull_request'], {
          cwd: directory,
          encoding: 'utf8',
        });
        expect(failure.status).not.toBe(0);
        expect(failure.stdout).toBe('');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});

describe('sandbox smoke test', () => {
  it.each([
    'scripts/dev-sandbox.mjs',
    'scripts/sandbox/launch.mjs',
    'src/backend/testing/fixtures/fake-codex-app-server.mjs',
    'e2e/sandbox-smoke.spec.ts',
    'playwright.sandbox.config.ts',
    'src/client/main.tsx',
    'src/backend/service.ts',
  ])('runs for %s', (file) => {
    expect(selectJobs('pull_request', ['docs/testing.md', file]).sandbox).toBe(true);
  });

  it('runs beside the required jobs and never gates them', () => {
    expect(ci.jobs.changes?.outputs?.sandbox).toBe('${{ steps.select.outputs.sandbox }}');
    const job = ci.jobs['sandbox-smoke'];
    expect(job?.needs).toBe('changes');
    expect(job?.if).toBe("needs.changes.outputs.sandbox == 'true'");
    // Promotion to required comes after 50 consecutive green runs on main.
    for (const [name, other] of Object.entries(ci.jobs)) {
      const needs = [other.needs ?? []].flat();
      expect(needs, name).not.toContain('sandbox-smoke');
    }
  });

  it('builds native modules, runs the spec and keeps its evidence on failure', () => {
    const scripts = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync('package.json', 'utf8'))).scripts;
    expect(scripts['test:e2e:sandbox']).toBe(
      'node scripts/ensure-native-modules.mjs node && playwright test --config=playwright.sandbox.config.ts'
    );
    const steps = ci.jobs['sandbox-smoke']?.steps ?? [];
    expect(steps.map((step) => step.run).filter(Boolean)).toContain('pnpm test:e2e:sandbox');
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('failure()');
    expect(String(upload?.with?.path).trim().split('\n')).toEqual([
      'test-results/sandbox/',
      'test-results/sandbox-logs/',
    ]);
  });
});

describe('required CI gates', () => {
  it('requires the minimum runtime to pass the Build gate', () => {
    const step = ci.jobs['require-build']?.steps?.[1];
    expect(step?.run).toBe(gateCommand);
    expect(step?.name).toBe('Require minimum runtime compatibility');
    expect(step?.env).toEqual({
      SELECTION_RESULT: '${{ needs.changes.result }}',
      SELECTED: '${{ needs.changes.outputs.app }}',
      WORK_RESULT: '${{ needs.minimum-node.result }}',
    });
  });

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
    expect(gate?.needs).toEqual(
      worker === 'build' ? ['changes', worker, 'minimum-node'] : ['changes', worker]
    );
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
  expect(install?.run?.trim()).toBe(
    [
      'pnpm install --frozen-lockfile --ignore-scripts --store-dir /__w/.pnpm-store',
      'pnpm rebuild @prisma/engines esbuild',
    ].join('\n')
  );
  expect(steps.find((step) => step.name === 'Generate Prisma client')?.run).toBe(
    'pnpm db:generate'
  );
  for (const worker of ['build', 'storybook', 'test-shards']) {
    const install = ci.jobs[worker]?.steps?.find((step) => step.name === 'Install dependencies');
    expect(install?.run).toBe('pnpm install --frozen-lockfile');
  }
});

it('installs only the minimal frozen coverage toolchain in the merge gate', () => {
  const steps = ci.jobs.test?.steps ?? [];
  expect(steps.find((step) => step.name === 'Install coverage toolchain')?.run).toBe(
    'pnpm --dir .github/coverage-merge install --frozen-lockfile'
  );
  expect(steps.some((step) => step.run?.includes('pnpm install'))).toBe(false);
  expect(steps.some((step) => step.name === 'Install dependencies')).toBe(false);
});

it('keeps the CI checks job to `pnpm check` plus the steps that only make sense in CI', () => {
  const scripts = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync('package.json', 'utf8'))).scripts;
  const runs = (ci.jobs.checks?.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
  // Local verification runs `pnpm check` and `pnpm typecheck`. The generated
  // client drift check needs a clean checkout, so it stays CI-only.
  expect(runs).toEqual([
    'pnpm install --frozen-lockfile',
    'pnpm db:generate',
    'pnpm check:prisma-generated',
    'pnpm check',
    'pnpm typecheck',
  ]);
  expect((scripts.check ?? '').split(' && ')).toEqual([
    'pnpm lint',
    'pnpm check:format',
    'pnpm check:file-length',
    'pnpm check:env',
    'pnpm check:imports',
    'pnpm check:ownership',
    'pnpm check:fk-indexes',
    'pnpm check:migrations',
    'pnpm deps:check',
    'pnpm knip',
    'pnpm check:unused-code',
    'pnpm check:guidance',
  ]);
  expect(scripts.lint).toContain('pnpm check:lint-suppressions');
  expect(scripts.knip).toBe('knip --include files,dependencies,unlisted');
  expect(scripts['check:migrations']).toBe(
    'prisma migrate diff --from-schema prisma/schema.prisma --to-migrations prisma/migrations --exit-code'
  );
});
