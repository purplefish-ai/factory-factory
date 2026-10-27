import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  updateProjectSettings,
  type ProjectSettingsPorts,
} from '@/backend/orchestration/project-settings.orchestrator';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { Project } from '@prisma-gen/client';

let db: IntegrationDatabase;
let projects: typeof import('@/backend/services/workspace').projectManagementService;
type StartupState = Pick<Project, 'startupScriptCommand' | 'startupScriptPath'>;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ projectManagementService: projects } = await vi.importActual<
    typeof import('@/backend/services/workspace')
  >('@/backend/services/workspace'));
}, 30_000);
afterEach(async () => {
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function createProject(slug = 'demo') {
  return db.prisma.project.create({
    data: { name: slug, slug, repoPath: `/repos/${slug}`, worktreeBasePath: `/worktrees/${slug}` },
  });
}

function realPorts() {
  const encrypt = vi.fn((key: string) => `encrypted:${key}`);
  const ports: ProjectSettingsPorts = {
    validateRepoPath: (path) => projects.validateRepoPath(path),
    findById: (id) => projects.findById(id),
    update: (id, updates) => projects.update(id, updates),
    updateIfStartupUnchanged: (id, expected, updates) =>
      projects.updateIfStartupUnchanged(id, expected, updates),
    encrypt,
  };
  return { ...ports, encrypt };
}

/** Both requests must finish their first SQLite read before either can write. */
function twoReaderBarrier(ports: ProjectSettingsPorts): ProjectSettingsPorts {
  const ready = gate();
  let reads = 0;
  return {
    ...ports,
    findById: async (id) => {
      const snapshot = await ports.findById(id);
      if (++reads <= 2) {
        if (reads === 2) {
          ready.open();
        }
        await ready.promise;
      }
      return snapshot;
    },
  };
}

function orderedWrites(ports: ProjectSettingsPorts) {
  const firstWritten = gate();
  function ordered(wait: Promise<void>, done: () => void): ProjectSettingsPorts {
    async function write<T>(operation: () => Promise<T>): Promise<T> {
      await wait;
      try {
        return await operation();
      } finally {
        done();
      }
    }
    return {
      ...ports,
      update: (...args) => write(() => ports.update(...args)),
      updateIfStartupUnchanged: (...args) => write(() => ports.updateIfStartupUnchanged(...args)),
    };
  }
  return [
    ordered(Promise.resolve(), firstWritten.open),
    ordered(firstWritten.promise, () => undefined),
  ] as const;
}

const keyConfig = {
  linear: { apiKey: 'new-key', teamId: 'team-1', teamName: 'Core', viewerName: 'Alice' },
};

describe('project startup settings concurrency with real SQLite', () => {
  it.each(['command', 'path'] as const)(
    'rejects opposite startup writes when %s wins the initial snapshot race',
    async (winner) => {
      const project = await createProject();
      const [first, second] = orderedWrites(twoReaderBarrier(realPorts()));
      const command = { startupScriptCommand: 'pnpm dev' };
      const path = { startupScriptPath: 'scripts/start.sh' };
      const results = await Promise.allSettled([
        updateProjectSettings(
          { id: project.id, ...(winner === 'command' ? command : path) },
          first
        ),
        updateProjectSettings(
          { id: project.id, ...(winner === 'command' ? path : command) },
          second
        ),
      ]);
      expect(await projects.findById(project.id)).toMatchObject({
        startupScriptCommand: winner === 'command' ? 'pnpm dev' : null,
        startupScriptPath: winner === 'path' ? 'scripts/start.sh' : null,
      });
      expect(results[0]?.status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: {
          message:
            'Cannot have both startupScriptCommand and startupScriptPath set. Please clear one by setting it to null.',
        },
      });
    }
  );

  it('retries valid same-field writes and encrypts a mixed credential patch once', async () => {
    const project = await createProject();
    const base = realPorts();
    const [first, second] = orderedWrites(twoReaderBarrier(base));
    const results = await Promise.all([
      updateProjectSettings({ id: project.id, startupScriptCommand: 'first' }, first),
      updateProjectSettings(
        { id: project.id, startupScriptCommand: 'second', issueTrackerConfig: keyConfig },
        second
      ),
    ]);
    expect(results.map((result) => result.startupScriptCommand)).toEqual(['first', 'second']);
    expect(await projects.findById(project.id)).toMatchObject({
      startupScriptCommand: 'second',
      startupScriptPath: null,
      issueTrackerConfig: { linear: { ...keyConfig.linear, apiKey: 'encrypted:new-key' } },
    });
    expect(base.encrypt).toHaveBeenCalledExactlyOnceWith('new-key');
    expect(keyConfig.linear.apiKey).toBe('new-key');
  });

  it('does not persist mixed credentials when contention makes the requested startup pair invalid', async () => {
    const project = await createProject();
    const base = realPorts();
    const [first, second] = orderedWrites(twoReaderBarrier(base));
    const results = await Promise.allSettled([
      updateProjectSettings({ id: project.id, startupScriptPath: 'scripts/start.sh' }, first),
      updateProjectSettings(
        { id: project.id, startupScriptCommand: 'pnpm dev', issueTrackerConfig: keyConfig },
        second
      ),
    ]);
    expect(results[1]?.status).toBe('rejected');
    expect(await projects.findById(project.id)).toMatchObject({
      startupScriptCommand: null,
      startupScriptPath: 'scripts/start.sh',
      issueTrackerConfig: null,
    });
    expect(base.encrypt).toHaveBeenCalledExactlyOnceWith('new-key');
  });

  it('allows another project to progress while one project is waiting before its write', async () => {
    const blocked = await createProject();
    const other = await createProject('other');
    const reached = gate();
    const release = gate();
    const base = realPorts();
    const slow = updateProjectSettings(
      { id: blocked.id, startupScriptCommand: 'slow' },
      {
        ...base,
        findById: async (id) => {
          const snapshot = await base.findById(id);
          reached.open();
          await release.promise;
          return snapshot;
        },
      }
    );
    await reached.promise;
    try {
      await expect(
        updateProjectSettings({ id: other.id, startupScriptPath: 'start.sh' }, realPorts())
      ).resolves.toMatchObject({ id: other.id, startupScriptPath: 'start.sh' });
      expect(await projects.findById(blocked.id)).toMatchObject({
        startupScriptCommand: null,
        startupScriptPath: null,
      });
    } finally {
      release.open();
    }
    await expect(slow).resolves.toMatchObject({ startupScriptCommand: 'slow' });
  });

  it('reports project deletion rather than contention when it disappears before the conditional write', async () => {
    const project = await createProject();
    const base = realPorts();
    await expect(
      updateProjectSettings(
        { id: project.id, startupScriptCommand: 'pnpm dev' },
        {
          ...base,
          updateIfStartupUnchanged: async (...args) => {
            await db.prisma.project.delete({ where: { id: project.id } });
            return base.updateIfStartupUnchanged(...args);
          },
        }
      )
    ).rejects.toThrow(`Project not found: ${project.id}`);
    await expect(projects.findById(project.id)).resolves.toBeNull();
  });

  it('conditionally writes the observed nullable pair, returns raw credentials, and preserves omitted settings', async () => {
    const project = await createProject();
    const empty: StartupState = { startupScriptCommand: null, startupScriptPath: null };
    const written = await projects.updateIfStartupUnchanged(project.id, empty, {
      startupScriptCommand: 'pnpm dev',
      issueTrackerConfig: { linear: { ...keyConfig.linear, apiKey: 'encrypted-key' } },
    });
    expect(written).toMatchObject({
      startupScriptCommand: 'pnpm dev',
      startupScriptPath: null,
      issueTrackerConfig: { linear: { ...keyConfig.linear, apiKey: 'encrypted-key' } },
    });
    await expect(
      projects.updateIfStartupUnchanged(project.id, empty, {
        startupScriptPath: 'stale.sh',
        name: 'must not persist',
      })
    ).resolves.toBeNull();
    expect(await projects.findById(project.id)).toMatchObject({
      name: project.name,
      startupScriptCommand: 'pnpm dev',
      startupScriptPath: null,
    });
    await expect(
      projects.updateIfStartupUnchanged(
        project.id,
        { startupScriptCommand: 'pnpm dev', startupScriptPath: null },
        { name: 'renamed' }
      )
    ).resolves.toMatchObject({
      name: 'renamed',
      issueTrackerConfig: { linear: { ...keyConfig.linear, apiKey: 'encrypted-key' } },
    });
    await expect(
      projects.updateIfStartupUnchanged(
        project.id,
        { startupScriptCommand: 'pnpm dev', startupScriptPath: null },
        { startupScriptCommand: null, startupScriptPath: 'start.sh', issueTrackerConfig: null }
      )
    ).resolves.toMatchObject({
      startupScriptCommand: null,
      startupScriptPath: 'start.sh',
      issueTrackerConfig: null,
    });
    await expect(
      projects.updateIfStartupUnchanged(project.id, empty, { name: 'stale pair' })
    ).resolves.toBeNull();
    await expect(
      projects.updateIfStartupUnchanged('missing', empty, { startupScriptCommand: 'pnpm dev' })
    ).resolves.toBeNull();
  });
});
