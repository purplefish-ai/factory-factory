import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const workflowStepSchema = z.object({
  env: z.record(z.string(), z.unknown()).optional(),
  id: z.string().optional(),
  if: z.string().optional(),
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

const workflowJobSchema = z.object({
  env: z.record(z.string(), z.unknown()).optional(),
  environment: z.string().optional(),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  permissions: z.record(z.string(), z.string()),
  steps: z.array(workflowStepSchema),
});

const workflowDispatchInputSchema = z.object({
  default: z.union([z.string(), z.boolean()]),
  description: z.string(),
  required: z.boolean(),
  type: z.literal('boolean'),
});

const publishWorkflowSchema = z.object({
  jobs: z.record(z.string(), workflowJobSchema),
  on: z.object({
    workflow_dispatch: z.object({
      inputs: z.record(z.string(), workflowDispatchInputSchema),
    }),
  }),
});

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/npm-publish.yml', import.meta.url)
);

const source = readFileSync(workflowPath, 'utf8');
const parsedWorkflow: unknown = parse(source);
const workflow = publishWorkflowSchema.parse(parsedWorkflow);

function getJob(name: string): z.infer<typeof workflowJobSchema> {
  const job = workflow.jobs[name];
  expect(job, `workflow job ${name} must exist`).toBeDefined();
  return workflowJobSchema.parse(job);
}

function getStep(
  job: z.infer<typeof workflowJobSchema>,
  name: string
): z.infer<typeof workflowStepSchema> {
  const step = job.steps.find((candidate) => candidate.name === name);
  expect(step, `workflow step ${name} must exist`).toBeDefined();
  return workflowStepSchema.parse(step);
}

function expectSecureNodeSetup(job: z.infer<typeof workflowJobSchema>): void {
  const setupNodeStep = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  expect(setupNodeStep?.with?.['package-manager-cache']).toBe(false);
  expect(setupNodeStep?.with).not.toHaveProperty('registry-url');
}

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`;
}

describe('npm publish workflow', () => {
  it('requires an explicit finalization dispatch after npm approval', () => {
    expect(workflow.on.workflow_dispatch.inputs.finalize_release).toEqual({
      default: 'false',
      description: 'Finalize after approving the staged package on npm',
      required: false,
      type: 'boolean',
    });
  });

  it('keeps verification and dry runs outside publishing credentials', () => {
    const verifyJob = getJob('verify');

    expect(verifyJob.if).toBe(
      githubExpression(
        "github.event_name == 'release' || github.event.inputs.finalize_release != 'true'"
      )
    );
    expect(verifyJob.environment).toBeUndefined();
    expect(verifyJob.permissions).toEqual({ contents: 'read' });
    expectSecureNodeSetup(verifyJob);
    expect(getStep(verifyJob, 'Install npm CLI').run).toBe('npm install --global npm@11.19.0');
    const dryRunStep = getStep(verifyJob, 'Publish to npm (dry run)');
    expect(dryRunStep.if).toBe(
      githubExpression(
        "matrix.node-version == '22.22' && github.event_name == 'workflow_dispatch' && github.event.inputs.dry_run == 'true'"
      )
    );
    expect(dryRunStep.run).toBe('npm publish --dry-run');
  });

  it('stages the packed artifact only in the protected OIDC job', () => {
    const stageJob = getJob('stage');

    expect(stageJob.needs).toBe('verify');
    expect(stageJob.if).toBe(
      githubExpression(
        "github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.event.inputs.dry_run != 'true' && github.event.inputs.finalize_release != 'true')"
      )
    );
    expect(stageJob.environment).toBe('npm-publish');
    expect(stageJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expectSecureNodeSetup(stageJob);
    expect(getStep(stageJob, 'Install npm CLI').run).toBe('npm install --global npm@11.19.0');
    expect(getStep(stageJob, 'Stage package on npm').run).toBe(
      'npm stage publish npm-package/factory-factory-*.tgz --access public'
    );

    const oidcJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions['id-token'] === 'write')
      .map(([name]) => name);
    expect(oidcJobs).toEqual(['stage']);
  });

  it('pins every external action to an immutable commit', () => {
    const actionReferences = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses ? [step.uses] : []))
    );

    expect(actionReferences).not.toHaveLength(0);
    for (const actionReference of actionReferences) {
      expect(actionReference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it('retains the package artifact for the protected-environment approval window', () => {
    const uploadStep = getStep(getJob('verify'), 'Upload npm package');
    expect(uploadStep.if).toBe(
      githubExpression(
        "matrix.node-version == '22.22' && (github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.event.inputs.dry_run != 'true' && github.event.inputs.finalize_release != 'true'))"
      )
    );
    expect(uploadStep.with).toEqual({
      name: 'npm-package',
      path: 'factory-factory-*.tgz',
      'if-no-files-found': 'error',
      'retention-days': 7,
    });

    const downloadStep = getStep(getJob('stage'), 'Download npm package');
    expect(downloadStep.with).toEqual({
      name: 'npm-package',
      path: 'npm-package',
    });
  });

  it('isolates GitHub release writes from the OIDC publisher', () => {
    const finalizeJob = getJob('finalize-release');

    expect(finalizeJob.needs).toBeUndefined();
    expect(finalizeJob.if).toBe(
      githubExpression(
        "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.event.inputs.dry_run != 'true' && github.event.inputs.finalize_release == 'true'"
      )
    );
    expect(finalizeJob.environment).toBeUndefined();
    expect(finalizeJob.permissions).toEqual({ contents: 'write' });
    const verifyPublishedStep = getStep(finalizeJob, 'Verify package is published on npm');
    expect(verifyPublishedStep.id).toBe('release_version');
    expect(verifyPublishedStep.run).toBe(`set -euo pipefail
VERSION=$(node -p "require('./package.json').version")
PUBLISHED_VERSION=$(npm view "factory-factory@$VERSION" version)
if [ "$PUBLISHED_VERSION" != "$VERSION" ]; then
  echo "factory-factory@$VERSION is not published on npm" >&2
  exit 1
fi
echo "version=$VERSION" >> "$GITHUB_OUTPUT"
`);
    getStep(finalizeJob, 'Create and push tag');
    expect(
      finalizeJob.steps.findIndex((step) => step.name === 'Verify package is published on npm')
    ).toBeLessThan(finalizeJob.steps.findIndex((step) => step.name === 'Create and push tag'));
    expect(getStep(finalizeJob, 'Create GitHub release')).toBeDefined();
  });

  it('does not configure a traditional npm token in any job', () => {
    const environmentKeys = Object.values(workflow.jobs).flatMap((job) => [
      ...Object.keys(job.env ?? {}),
      ...job.steps.flatMap((step) => Object.keys(step.env ?? {})),
    ]);

    expect(environmentKeys).not.toContain('NODE_AUTH_TOKEN');
  });
});
