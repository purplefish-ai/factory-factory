import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { SlackSocketHandlers } from '@/backend/services/agent-definition';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let orchestrator: typeof import('./slack-intake.orchestrator');
let jobRunner: typeof import('@/backend/services/job-runner.service').jobRunner;
let connectionId: string;
let enabled: boolean;
let sockets: Array<{ token: string; handlers: SlackSocketHandlers; disconnects: number }>;

function intake() {
  return orchestrator.createSlackIntake(
    () => ({
      slackConnectionService: {
        getAppCredentials: (id) =>
          Promise.resolve({ connectionId: id, workspaceId: 'T1', appId: 'A1', appToken: 'xapp-1' }),
      },
      configService: { getAgentRuntimeLimits: () => ({ slackIntakeEnabled: enabled }) },
    }),
    (token, handlers) => {
      const socket = { token, handlers, disconnects: 0 };
      sockets.push(socket);
      return {
        start: () => {
          handlers.onHello({ type: 'hello', connection_info: { app_id: 'A1' } });
          return Promise.resolve();
        },
        disconnect: () => {
          socket.disconnects++;
          return Promise.resolve();
        },
      };
    }
  );
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  orchestrator = await vi.importActual<typeof import('./slack-intake.orchestrator')>(
    './slack-intake.orchestrator'
  );
  ({ jobRunner } = await vi.importActual<typeof import('@/backend/services/job-runner.service')>(
    '@/backend/services/job-runner.service'
  ));
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.project.deleteMany();
  const project = await db.prisma.project.create({
    data: { name: 'P', slug: crypto.randomUUID(), repoPath: '/r', worktreeBasePath: '/w' },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: { projectId: project.id, name: 'A', instructions: 'Help', isEnabled: true },
  });
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'SLACK', externalId: 'T1', name: 'Company', credentialsEncrypted: 'x' },
  });
  connectionId = connection.id;
  await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: definition.id,
      connectionId,
      type: 'SLACK_MESSAGE',
      description: 'Support',
      config: { version: 1, channelIds: ['C1'] },
      isEnabled: true,
      isConfigured: true,
      activationState: 'ACTIVE',
    },
  });
  sockets = [];
});
afterEach(async () => {
  await jobRunner.stopAll();
  jobRunner.reset();
});

it('listens from start and records the stop before returning from shutdown', async () => {
  enabled = true;
  const runtime = intake();
  runtime.start();
  await jobRunner.waitForCurrentRun('agent-slack-intake');
  expect(sockets.map((socket) => socket.token)).toEqual(['xapp-1']);
  expect(
    await db.prisma.agentSourceState.findUniqueOrThrow({ where: { connectionId } })
  ).toMatchObject({ isReady: true, health: { state: 'READY' } });
  await runtime.stop();
  expect(sockets[0]?.disconnects).toBe(1);
  expect(
    await db.prisma.agentSourceState.findUniqueOrThrow({ where: { connectionId } })
  ).toMatchObject({
    isReady: false,
    health: { state: 'DISCONNECTED', reasonCode: 'SLACK_LISTENER_STOPPED' },
  });
});

it('opens no Slack connection while the intake gate is off', async () => {
  enabled = false;
  const runtime = intake();
  runtime.start();
  await jobRunner.waitForCurrentRun('agent-slack-intake');
  await vi.waitFor(() => expect(jobRunner.isRunning('agent-slack-intake')).toBe(true));
  expect(sockets).toEqual([]);
  await runtime.stop();
});
