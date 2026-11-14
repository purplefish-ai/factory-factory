import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition/index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
const execution: EventAgentExecution = {
  version: 1,
  provider: 'CLAUDE',
  model: 'sonnet',
  reasoningEffort: null,
  codexAccountId: null,
  startupModePreset: 'non_interactive',
  accessMode: 'bypassPermissions',
  planModeEnabled: false,
};
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('@/backend/services/agent-definition/index')>(
    '@/backend/services/agent-definition/index'
  );
}, 30_000);
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function claimed() {
  await fixture.admit(await fixture.event());
  const claim = await runtime.claimNextRun();
  if (claim.status !== 'CLAIMED') {
    throw new Error('Expected claim');
  }
  const binding = await runtime.readEventExecutionBinding(claim);
  await runtime.freezeEventExecution({ claim, ...binding, execution });
  return claim;
}
/** Creates the reserved workspace and session, with consistent origins, in the given project. */
async function reserve(claim: Awaited<ReturnType<typeof claimed>>, projectId: string) {
  const workspace = await db.prisma.workspace.create({
    data: {
      id: claim.reservedWorkspaceId,
      projectId,
      name: 'Event run',
      creationSource: 'EVENT_AGENT',
    },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: { runId: claim.runId, workspaceId: workspace.id, projectId },
  });
  await db.prisma.agentSession.create({
    data: {
      id: claim.reservedSessionId,
      workspaceId: workspace.id,
      workflow: 'event',
      provider: 'CLAUDE',
    },
  });
  await db.prisma.agentSessionLaunchOrigin.create({
    data: {
      runId: claim.runId,
      sessionId: claim.reservedSessionId,
      workspaceId: workspace.id,
      execution,
    },
  });
}
async function linkedWorkspace(runId: string) {
  return (await db.prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).workspaceId;
}

it('links the reserved workspace when it belongs to the automation project', async () => {
  const claim = await claimed();
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  await reserve(claim, definition.projectId);
  await runtime.eventRunLaunch.link(claim);
  expect(await linkedWorkspace(claim.runId)).toBe(claim.reservedWorkspaceId);
});

it('refuses to link a reserved workspace that belongs to another project', async () => {
  const claim = await claimed();
  const other = await db.prisma.project.create({
    data: {
      name: 'Other',
      slug: crypto.randomUUID(),
      repoPath: '/other',
      worktreeBasePath: '/other-worktrees',
    },
  });
  await reserve(claim, other.id);
  await expect(runtime.eventRunLaunch.link(claim)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await linkedWorkspace(claim.runId)).toBeNull();
});
