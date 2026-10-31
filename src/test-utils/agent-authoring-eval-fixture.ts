import { once } from 'node:events';
import { createServer } from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { vi } from 'vitest';
import { createAgentAuthoring } from '@/backend/orchestration/agent-authoring.orchestrator';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
} from '@/backend/testing/integration-db';
import { agentRouter } from '@/backend/trpc/agent.trpc';
import { router } from '@/backend/trpc/trpc';

/** Real authoring API/database with deterministic external provider responses. */
export async function createAgentAuthoringEvalFixture() {
  const db = await createIntegrationDatabase();
  const { AgentProposalService, SlackConnectionService } = await vi.importActual<
    typeof import('@/backend/services/agent-definition')
  >('@/backend/services/agent-definition');
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory Factory',
      slug: 'factory',
      repoPath: db.tempDir,
      worktreeBasePath: db.tempDir,
      githubOwner: 'purplefish-ai',
      githubRepo: 'factory-factory',
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: { projectId: project.id, name: 'Authoring evaluation' },
  });
  const channels = [
    { id: 'C-feedback', name: 'customer-feedback' },
    { id: 'C-data', name: 'data-quality' },
    { id: 'C-bugs', name: 'bug-reports' },
    { id: 'C-review', name: 'fillet-packet-review' },
    { id: 'C-engineering', name: 'engineering-bugs' },
  ];
  for (const [id, name] of [
    ['company', 'Company'],
    ['partner', 'Partner'],
  ]) {
    await db.prisma.agentConnection.create({
      data: {
        id: `slack-${id}`,
        provider: 'SLACK',
        externalId: `T-${id}`,
        name: name ?? '',
        credentialsEncrypted: `token-${id}`,
      },
    });
  }
  const slack = new SlackConnectionService(
    { encrypt: (value) => value, decrypt: (value) => value },
    (url, init) => {
      const request = new URL(String(url));
      const partner = new Headers(init?.headers).get('Authorization') === 'Bearer token-partner';
      const available = (partner ? [{ id: 'C-partner-bugs', name: 'bug-reports' }] : channels).map(
        (channel) => ({ ...channel, is_member: true, is_archived: false })
      );
      const id = request.searchParams.get('channel');
      const channel = available.find((value) => value.id === id);
      return Promise.resolve(
        new Response(
          JSON.stringify(id ? { ok: Boolean(channel), channel } : { ok: true, channels: available })
        )
      );
    }
  );
  const services = {
    configService: { getCorsConfig: () => ({ allowedOrigins: [] }) },
    workspaceDataService: {
      findByIdWithProject: (id: string) =>
        db.prisma.workspace.findUnique({ where: { id }, include: { project: true } }),
    },
    slackConnectionService: slack,
    agentProposalService: new AgentProposalService(),
    githubCLIService: {
      getAgentRepository: async () => ({
        id: '123',
        name: 'purplefish-ai/factory-factory',
        labels: ['bug', 'agent'],
      }),
    },
  };
  const paths: string[] = [];
  const app = express();
  app.use('/api/trpc', (req, _res, next) => {
    paths.push(req.path);
    next();
  });
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: router({ agent: agentRouter }),
      createContext: () =>
        ({
          appContext: {
            services: {
              ...services,
              agentAuthoring: createAgentAuthoring(() => services as never),
            },
          },
        }) as never,
    })
  );
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server port');
  }
  return {
    db,
    workspaceId: workspace.id,
    paths,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
      await destroyIntegrationDatabase(db);
    },
  };
}
