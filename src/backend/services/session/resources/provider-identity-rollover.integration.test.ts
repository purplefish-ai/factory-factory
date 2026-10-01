import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let accessor: typeof import('./agent-session.accessor').agentSessionAccessor;
let counter = 0;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentSessionAccessor: accessor } = await vi.importActual<
    typeof import('./agent-session.accessor')
  >('./agent-session.accessor'));
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function fixture() {
  const project = await db.prisma.project.create({
    data: {
      name: 'fixture',
      slug: `identity-${counter++}`,
      repoPath: '/tmp/identity-fixture',
      worktreeBasePath: '/tmp/identity-fixture',
      defaultBranch: 'main',
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: { name: 'fixture', projectId: project.id },
  });
  return db.prisma.agentSession.create({
    data: {
      workspaceId: workspace.id,
      workflow: 'default',
      provider: 'CODEX',
      model: 'test',
      providerSessionId: 'old',
      providerMetadata: { acpConfigSnapshot: { providerSessionId: 'old' } },
    },
  });
}

describe('atomic provider identity reconciliation in SQLite', () => {
  it('commits identity, config snapshot and audit together without a null identity window', async () => {
    const session = await fixture();
    const metadata = {
      acpConfigSnapshot: { providerSessionId: 'new' },
      providerIdentityRollovers: [
        { previousProviderSessionId: 'old', providerSessionId: 'new', incarnationId: 'runtime-1' },
      ],
    };
    expect(
      await accessor.rolloverProviderIdentity(session.id, {
        previousProviderSessionId: 'old',
        providerSessionId: 'new',
        expectedUpdatedAt: session.updatedAt,
        expectedProviderMetadata: session.providerMetadata,
        providerMetadata: metadata,
      })
    ).toBe(1);
    const persisted = await accessor.findById(session.id);
    expect(persisted?.providerSessionId).toBe('new');
    expect(persisted?.providerMetadata).toEqual(metadata);
  });

  it('rejects stale identity and stale metadata versions without a partial write', async () => {
    const session = await fixture();
    const expectedUpdatedAt = new Date(session.updatedAt.getTime() - 1);
    const input = {
      previousProviderSessionId: 'old',
      providerSessionId: 'wrong',
      expectedUpdatedAt,
      expectedProviderMetadata: session.providerMetadata,
      providerMetadata: { acpConfigSnapshot: { providerSessionId: 'wrong' } },
    };
    expect(await accessor.rolloverProviderIdentity(session.id, input)).toBe(0);
    expect(
      await accessor.rolloverProviderIdentity(session.id, {
        ...input,
        expectedUpdatedAt: session.updatedAt,
        expectedProviderMetadata: session.providerMetadata,
        previousProviderSessionId: 'different',
      })
    ).toBe(0);
    const persisted = await accessor.findById(session.id);
    expect(persisted?.providerSessionId).toBe('old');
    expect(persisted?.providerMetadata).toEqual(session.providerMetadata);
  });

  it('rejects changed metadata even when timestamps coincide', async () => {
    const session = await fixture();
    await db.prisma.agentSession.update({
      where: { id: session.id },
      data: { providerMetadata: { preserved: 'concurrent update' }, updatedAt: session.updatedAt },
    });
    expect(
      await accessor.rolloverProviderIdentity(session.id, {
        previousProviderSessionId: 'old',
        providerSessionId: 'wrong',
        expectedUpdatedAt: session.updatedAt,
        expectedProviderMetadata: session.providerMetadata,
        providerMetadata: {},
      })
    ).toBe(0);
    expect((await accessor.findById(session.id))?.providerMetadata).toEqual({
      preserved: 'concurrent update',
    });
  });

  it('prevents an old configuration write from undoing an atomic rollover', async () => {
    const session = await fixture();
    const metadata = {
      acpConfigSnapshot: { providerSessionId: 'new' },
      providerIdentityRollovers: ['audit'],
    };
    await accessor.rolloverProviderIdentity(session.id, {
      previousProviderSessionId: 'old',
      providerSessionId: 'new',
      expectedUpdatedAt: session.updatedAt,
      expectedProviderMetadata: session.providerMetadata,
      providerMetadata: metadata,
    });
    expect(
      await accessor.updateIfProviderIdentity(session.id, session, {
        providerMetadata: { acpConfigSnapshot: { providerSessionId: 'old' } },
      })
    ).toBe(0);
    expect((await accessor.findById(session.id))?.providerMetadata).toEqual(metadata);
  });

  it('allows only one concurrent repair for the same original identity', async () => {
    const session = await fixture();
    const results = await Promise.all(
      ['first', 'second'].map((providerSessionId) =>
        accessor.rolloverProviderIdentity(session.id, {
          previousProviderSessionId: 'old',
          providerSessionId,
          expectedUpdatedAt: session.updatedAt,
          expectedProviderMetadata: session.providerMetadata,
          providerMetadata: { acpConfigSnapshot: { providerSessionId } },
        })
      )
    );
    expect([...results].sort()).toEqual([0, 1]);
    const persisted = await accessor.findById(session.id);
    expect(persisted?.providerMetadata).toEqual({
      acpConfigSnapshot: { providerSessionId: persisted?.providerSessionId },
    });
  });
});
