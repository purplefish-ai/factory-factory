import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
  concurrency: z.object({
    group: z.string(),
    'cancel-in-progress': z.union([z.boolean(), z.string()]),
  }),
  jobs: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      if: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      'runs-on': z.string().optional(),
      strategy: z
        .object({
          'fail-fast': z.boolean().optional(),
          matrix: z
            .object({
              os: z.array(z.string()).optional(),
              'node-version': z.array(z.string()).optional(),
              shard: z.array(z.union([z.string(), z.number()])).optional(),
              include: z.array(z.record(z.string(), z.string())).optional(),
            })
            .optional(),
        })
        .optional(),
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

interface ListedSuite {
  file: string;
  specs: { tests: { projectName: string }[] }[];
  suites?: ListedSuite[];
}
const listedSuiteSchema: z.ZodType<ListedSuite> = z.lazy(() =>
  z.object({
    file: z.string(),
    specs: z.array(z.object({ tests: z.array(z.object({ projectName: z.string() })) })),
    suites: z.array(listedSuiteSchema).optional(),
  })
);

/**
 * The sandbox projects and which spec file each test runs in, as Playwright itself selects them
 * from the config. List mode loads the specs without the global setup, so no sandbox starts.
 */
function listSandboxSpecs() {
  const result = spawnSync(
    resolve('node_modules/.bin/playwright'),
    ['test', '--config=playwright.sandbox.config.ts', '--list', '--reporter=json'],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`playwright --list failed: ${result.stderr}${result.stdout}`);
  }
  const report = z
    .object({
      config: z.object({ projects: z.array(z.object({ name: z.string() })) }),
      suites: z.array(listedSuiteSchema),
    })
    .parse(JSON.parse(result.stdout));
  const tests: [file: string, project: string][] = [];
  const visit = (suite: ListedSuite) => {
    for (const spec of suite.specs) {
      tests.push(...spec.tests.map((test): [string, string] => [suite.file, test.projectName]));
    }
    suite.suites?.forEach(visit);
  };
  report.suites.forEach(visit);
  return { projects: report.config.projects.map((project) => project.name), tests };
}

describe('conservative CI selection', () => {
  it('builds with the development pin and launches the same tarball on each supported floor', () => {
    const build = ci.jobs.build;
    const buildSetup = build?.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(buildSetup?.with?.['node-version-file']).toBe('.node-version');
    expect(build?.steps?.find((step) => step.name === 'Pack consumer artifact')?.run).toContain(
      'npm pack'
    );
    const uploaded = build?.steps?.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    );
    expect(uploaded?.with?.path).toBe('factory-factory-*.tgz');

    const job = ci.jobs['minimum-node'];
    expect(job?.needs).toEqual(['changes', 'build']);
    expect(job?.if).toBe("needs.changes.outputs.app == 'true'");
    const requirement = readFileSync('.node-minimum', 'utf8').trim();
    expect(job?.strategy?.matrix?.['node-version']).toEqual(
      requirement.split(' || ').map((floor) => floor.replace(/^\^|^>=/, ''))
    );
    const setup = job?.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setup?.with?.['node-version']).toBe('${{ matrix.node-version }}');
    const downloaded = job?.steps?.find((step) =>
      step.uses?.startsWith('actions/download-artifact@')
    );
    expect(downloaded?.with?.name).toBe(uploaded?.with?.name);
    const smoke = job?.steps?.find((step) => step.name === 'Launch the packed CLI')?.run;
    expect(downloaded?.with?.path).toBe('npm-package');
    expect(smoke).toBe('bash scripts/check-packed-consumer.sh cold');
  });

  it('runs the packed checks on macOS beside Ubuntu, on the oldest floor only', () => {
    const job = ci.jobs['minimum-node'];
    expect(job?.['runs-on']).toBe('${{ matrix.os }}');
    expect(job?.strategy?.['fail-fast']).toBe(false);
    expect(job?.strategy?.matrix?.os).toEqual(['ubuntu-latest']);
    const floors = job?.strategy?.matrix?.['node-version'] ?? [];
    // One macOS leg rather than one per floor: macOS runners are slower and scarcer.
    expect(job?.strategy?.matrix?.include).toEqual([
      { os: 'macos-latest', 'node-version': floors[0] },
    ]);
    // The leg needs nothing but the packed artifact, so it stays off the browser and test work.
    expect(job?.steps?.map((step) => step.uses?.split('@')[0] ?? step.run)).toEqual([
      'actions/checkout',
      'actions/download-artifact',
      'actions/setup-node',
      'bash scripts/check-packed-consumer.sh cold',
    ]);
    // Other jobs stay on Ubuntu, the browser smoke test included.
    for (const [name, other] of Object.entries(ci.jobs)) {
      if (name !== 'minimum-node') {
        expect(other['runs-on'], name).toBe('ubuntu-latest');
      }
    }
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
  let sandboxListing: ReturnType<typeof listSandboxSpecs>;
  beforeAll(() => {
    sandboxListing = listSandboxSpecs();
  }, 60_000);

  it.each([
    'scripts/dev-sandbox.mjs',
    'scripts/sandbox/launch.mjs',
    'src/backend/testing/fixtures/fake-codex-app-server.mjs',
    'src/backend/testing/fixtures/fake-claude-cli.mjs',
    'e2e/sandbox/echo.spec.ts',
    'playwright.sandbox.config.ts',
    'src/client/main.tsx',
    'src/backend/service.ts',
  ])('runs for %s', (file) => {
    expect(selectJobs('pull_request', ['docs/testing.md', file]).sandbox).toBe(true);
  });

  it('runs the shards in parallel beside the required jobs, joined only by Smoke', () => {
    expect(ci.jobs.changes?.outputs?.sandbox).toBe('${{ steps.select.outputs.sandbox }}');
    const job = ci.jobs['smoke-shards'];
    expect(job?.needs).toBe('changes');
    expect(job?.if).toBe("needs.changes.outputs.sandbox == 'true'");
    expect(job?.strategy?.['fail-fast']).toBe(false);
    expect(job?.strategy?.matrix?.shard).toEqual(sandboxListing.projects);
    for (const [name, other] of Object.entries(ci.jobs)) {
      const needs = [other.needs ?? []].flat();
      if (name !== 'require-smoke') {
        expect(needs, name).not.toContain('smoke-shards');
      }
      expect(needs, name).not.toContain('require-smoke');
    }
  });

  it('aggregates the shards as Smoke the way Build and Test aggregate their work', () => {
    const gate = ci.jobs['require-smoke'];
    expect(gate?.name).toBe('Smoke');
    expect(gate?.if).toBe('always()');
    expect(gate?.needs).toEqual(['changes', 'smoke-shards']);
    expect(gate?.steps).toHaveLength(1);
    expect(gate?.steps?.[0]?.run).toBe(gateCommand);
    expect(gate?.steps?.[0]?.env).toEqual({
      SELECTION_RESULT: '${{ needs.changes.result }}',
      SELECTED: '${{ needs.changes.outputs.sandbox }}',
      WORK_RESULT: '${{ needs.smoke-shards.result }}',
    });
  });

  it('runs every sandbox spec file in exactly one shard: restart and crash specs apart', () => {
    const assigned = new Map<string, Set<string>>();
    for (const [file, project] of sandboxListing.tests) {
      assigned.set(file, (assigned.get(file) ?? new Set()).add(project));
    }
    // Any file named like a spec counts, so a misnamed one shows up here as running nowhere.
    const files = readdirSync('e2e/sandbox').filter((name) => name.includes('.spec.'));
    expect(files.length).toBeGreaterThan(0);
    expect(
      Object.fromEntries(files.map((file) => [file, [...(assigned.get(file) ?? [])].toSorted()]))
    ).toEqual(
      Object.fromEntries(
        files.map((file) => [
          file,
          [/^(?:restart-.*|crash-points)\.spec\.ts$/.test(file) ? 'restart' : 'general'],
        ])
      )
    );
  });

  it('runs each shard with its own sandbox, a cached browser and its own evidence', () => {
    const scripts = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync('package.json', 'utf8'))).scripts;
    // Locally one command still runs every project against one sandbox.
    expect(scripts['test:e2e:sandbox']).toBe(
      'playwright test --config=playwright.sandbox.config.ts'
    );
    const steps = ci.jobs['smoke-shards']?.steps ?? [];
    expect(steps.map((step) => step.run).filter(Boolean)).toContain(
      'pnpm test:e2e:sandbox --project=${{ matrix.shard }}'
    );
    const cache = steps.find((step) => step.uses?.startsWith('actions/cache@'));
    expect(cache?.with?.path).toBe('~/.cache/ms-playwright');
    expect(cache?.with?.key).toContain('${{ steps.playwright.outputs.version }}');
    expect(steps.find((step) => step.name === 'Read the Playwright version')?.run).toBe(
      `echo "version=$(node -p "require('@playwright/test/package.json').version")" >> "$GITHUB_OUTPUT"`
    );
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('failure()');
    expect(upload?.with?.name).toBe('sandbox-smoke-evidence-${{ matrix.shard }}');
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

it('supersedes only pull request revisions: pushes to main, queues and schedules each run to a verdict', () => {
  const codeql = workflowSchema.parse(parse(readFileSync('.github/workflows/codeql.yml', 'utf8')));
  for (const workflow of [ci, codeql]) {
    // A pull request shares one group per workflow and number, so a newer revision replaces
    // the older one. Any other event falls through to its own run id: a later push to main
    // neither cancels nor replaces the run for an earlier commit, and merge_group runs stay
    // independent. Grouping on the ref would drop a pending run even without cancellation.
    expect(workflow.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}"
    );
    expect(workflow.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}"
    );
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

describe('weekly agent metrics workflow', () => {
  const metricsSource = readFileSync('.github/workflows/agent-metrics.yml', 'utf8');
  const metrics = z
    .object({
      on: z.record(z.string(), z.unknown()),
      permissions: z.record(z.string(), z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      jobs: z.record(
        z.string(),
        z.object({
          permissions: z.record(z.string(), z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          steps: z.array(stepSchema),
        })
      ),
    })
    .parse(parse(metricsSource));
  const steps = Object.values(metrics.jobs).flatMap((job) => job.steps);
  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  const actionName = (uses: string | undefined) => uses?.split('@')[0];
  const findAction = (workflowSteps: typeof steps, name: string) =>
    workflowSteps.find((step) => actionName(step.uses) === name);

  it('runs weekly and on demand, and on no other trigger', () => {
    expect(Object.keys(metrics.on).toSorted()).toEqual(['schedule', 'workflow_dispatch']);
    const schedule = z.array(z.object({ cron: z.string() })).parse(metrics.on.schedule);
    expect(schedule).toHaveLength(1);
    // Mondays at 06:17 UTC.
    expect(schedule[0]?.cron).toBe('17 6 * * 1');
  });

  it('can only read, and uses no secret but the workflow token', () => {
    // `gh` reads CI runs (actions) and pull requests; the checkout reads contents.
    expect(Object.values(metrics.jobs).map((job) => job.permissions)).toEqual([
      { contents: 'read', actions: 'read', 'pull-requests': 'read' },
    ]);
    expect(Object.values(metrics.permissions ?? {}).every((level) => level === 'read')).toBe(true);
    expect(metricsSource).not.toMatch(/:\s*write\b|write-all/);
    expect(metricsSource).not.toContain('secrets.');
    expect(metricsSource).not.toContain('pull_request_target');
    // Neither the workflow nor the job defines an environment, so a token cannot reach a step
    // that does not name it.
    expect(metrics.env).toBeUndefined();
    expect(Object.values(metrics.jobs).map((job) => job.env)).toEqual([undefined]);
    // The token is on the one step that runs the script, and on no other.
    const withToken = steps.filter((step) => step.env !== undefined);
    expect(withToken.map((step) => step.env)).toEqual([{ GH_TOKEN: '${{ github.token }}' }]);
    expect(withToken.map((step) => step.run)).toEqual([
      'pnpm metrics:agents --json-file agent-metrics.json >> "$GITHUB_STEP_SUMMARY"',
    ]);
    expect(findAction(steps, 'actions/checkout')?.with).toMatchObject({
      'persist-credentials': false,
    });
  });

  it('commits, pushes and comments on nothing, and interpolates nothing into a shell', () => {
    expect(commands.join('\n')).not.toMatch(
      /\bgit\s+(commit|push|tag|add)\b|\bgh\s+(pr|issue|release|workflow|api)\b|--method|-X\s*(POST|PUT|PATCH|DELETE)/
    );
    for (const command of commands) {
      expect(command).not.toContain('${{');
    }
    expect(steps.map((step) => actionName(step.uses)).filter(Boolean)).toEqual([
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'actions/upload-artifact',
    ]);
  });

  it('pins every action to the commit and version that ci.yml pins', () => {
    // The version comment after the commit is part of the pin, and YAML drops it.
    const pins = (source: string) =>
      [...source.matchAll(/\buses: (\S+@[0-9a-f]{40} # v\d.*)$/gm)].map((match) => match[1] ?? '');
    const ciPins = pins(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const metricsPins = pins(metricsSource);
    expect(metricsPins).toHaveLength(steps.filter((step) => step.uses).length);
    for (const pin of metricsPins) {
      expect(ciPins, pin).toContain(pin);
    }
  });

  it('sets up Node and pnpm the way ci.yml does, with the history the script reads', () => {
    const ciChecks = ci.jobs.checks?.steps ?? [];
    for (const name of ['actions/setup-node', 'pnpm/action-setup']) {
      expect(findAction(steps, name)?.with, name).toEqual(findAction(ciChecks, name)?.with);
    }
    expect(findAction(steps, 'actions/setup-node')?.with).toMatchObject({
      'node-version-file': '.node-version',
    });
    // The script reads the last 300 commits; a shallow clone would shorten that silently.
    expect(findAction(steps, 'actions/checkout')?.with).toMatchObject({ 'fetch-depth': 0 });
  });

  it('writes the Markdown to the job summary and uploads the JSON as an artifact', () => {
    expect(commands).toContain('pnpm install --frozen-lockfile');
    expect(commands).toContain(
      'pnpm metrics:agents --json-file agent-metrics.json >> "$GITHUB_STEP_SUMMARY"'
    );
    // One run, so one collection: a second would repeat the `gh` calls and could differ.
    expect(commands.filter((command) => command.includes('metrics:agents'))).toHaveLength(1);
    expect(findAction(steps, 'actions/upload-artifact')?.with).toMatchObject({
      name: 'agent-metrics',
      path: 'agent-metrics.json',
      'if-no-files-found': 'error',
      'retention-days': 90,
    });
  });
});

describe('npm release tagging workflow', () => {
  const source = readFileSync('.github/workflows/release-tags.yml', 'utf8');
  const workflow = z
    .object({
      on: z.record(z.string(), z.unknown()),
      permissions: z.record(z.string(), z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }),
      jobs: z.record(
        z.string(),
        z.object({
          if: z.string().optional(),
          permissions: z.record(z.string(), z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          steps: z.array(stepSchema),
        })
      ),
    })
    .parse(parse(source));
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const actionName = (uses: string | undefined) => uses?.split('@')[0];
  const tagStep = steps.find((step) => step.run?.includes('scripts/tag-npm-releases.ts'));

  it('runs every six hours and on demand, one run at a time, only from main of this repository', () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(['schedule', 'workflow_dispatch']);
    expect(z.array(z.object({ cron: z.string() })).parse(workflow.on.schedule)).toEqual([
      { cron: '41 */6 * * *' },
    ]);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    // A fork with schedules enabled skips the job instead of failing it.
    expect(Object.values(workflow.jobs).map((job) => job.if)).toEqual([
      "${{ github.repository == 'purplefish-ai/factory-factory' && github.ref == 'refs/heads/main' }}",
    ]);
  });

  it('can write contents and nothing else, with the workflow token on the one step that writes', () => {
    expect(workflow.permissions).toBeUndefined();
    expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual([
      { contents: 'write' },
    ]);
    expect(source).not.toContain('secrets.');
    expect(workflow.env).toBeUndefined();
    expect(Object.values(workflow.jobs).map((job) => job.env)).toEqual([undefined]);
    // A release created with any other token would start the npm publish workflow.
    expect(steps.filter((step) => step.env?.GH_TOKEN !== undefined)).toEqual([tagStep]);
    expect(tagStep?.env?.GH_TOKEN).toBe('${{ github.token }}');
    const checkout = steps.find((step) => actionName(step.uses) === 'actions/checkout');
    expect(checkout?.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    expect(steps.map((step) => step.run).filter(Boolean)).toContain(
      'pnpm install --frozen-lockfile --ignore-scripts'
    );
  });

  it('pins every action to the commit and version that ci.yml pins', () => {
    const pins = (text: string) =>
      [...text.matchAll(/\buses: (\S+@[0-9a-f]{40} # v\d.*)$/gm)].map((match) => match[1] ?? '');
    const ciPins = pins(readFileSync('.github/workflows/ci.yml', 'utf8'));
    expect(pins(source)).toHaveLength(steps.filter((step) => step.uses).length);
    for (const pin of pins(source)) {
      expect(ciPins, pin).toContain(pin);
    }
  });

  it('declares the dry_run input and a backlog choice that defaults to leaving it alone', () => {
    // Without the declared input, a requested manual dry run would run for real.
    expect(workflow.on.workflow_dispatch).toMatchObject({
      inputs: {
        dry_run: { required: false, default: false, type: 'boolean' },
        backlog: {
          required: false,
          default: 'none',
          type: 'choice',
          options: ['none', 'tags', 'releases'],
        },
      },
    });
    expect(tagStep?.env?.DRY_RUN).toBe('${{ inputs.dry_run }}');
    expect(tagStep?.env?.BACKLOG).toBe('${{ inputs.backlog }}');
  });

  const base = ['--repository', 'owner/name', '--backlog'];
  it.each([
    // A scheduled run has no inputs.
    ['', '', [...base, 'none']],
    ['none', 'false', [...base, 'none']],
    ['none', 'true', [...base, 'none', '--dry-run']],
    ['tags', 'true', [...base, 'tags', '--dry-run']],
    ['releases', 'false', [...base, 'releases']],
  ])('passes backlog %j and dry_run %j to the script', (backlog, dryRun, expected) => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-release-tags-'));
    try {
      // A stand-in pnpm prints the script arguments, one per line.
      writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nshift 3\nprintf "%s\\n" "$@"\n', {
        mode: 0o755,
      });
      const summary = join(directory, 'summary.md');
      const result = spawnSync('bash', ['-c', z.string().parse(tagStep?.run)], {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          DRY_RUN: dryRun,
          BACKLOG: backlog,
          GITHUB_REPOSITORY: 'owner/name',
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual(expected);
      expect(readFileSync(summary, 'utf8')).toBe(result.stdout);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
