import { describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('../db', () => ({
  prisma: {
    workspace: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

import { workspaceAccessor } from './workspace.accessor';

describe('workspaceAccessor.create', () => {
  it('passes ratchetEnabled when provided', async () => {
    mockCreate.mockResolvedValue({ id: 'ws-1' });

    await workspaceAccessor.create({
      projectId: 'project-1',
      name: 'Issue workspace',
      githubIssueNumber: 12,
      ratchetEnabled: false,
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        name: 'Issue workspace',
        githubIssueNumber: 12,
        ratchetEnabled: false,
      }),
    });
  });

  it('keeps ratchetEnabled undefined when not provided', async () => {
    mockCreate.mockResolvedValue({ id: 'ws-2' });

    await workspaceAccessor.create({
      projectId: 'project-1',
      name: 'Manual workspace',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        name: 'Manual workspace',
        ratchetEnabled: undefined,
      }),
    });
  });
});
