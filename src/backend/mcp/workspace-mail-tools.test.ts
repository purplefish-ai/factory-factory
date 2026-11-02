import { describe, expect, it, vi } from 'vitest';
import { callWorkspaceMailTool, WORKSPACE_MAIL_TOOLS } from './workspace-mail-tools';

const summary = {
  id: 'mail-1',
  revision: 1,
  subject: 'Review ready',
  preview: 'Summary',
  kind: 'COMPLETION',
  taskKey: 'review',
  taskRevision: 1,
  sourceWorkspaceId: 'sender',
  sourceWorkspaceName: 'Sender',
  sourceProjectName: 'Project',
  createdAt: '2026-11-02T00:00:00.000Z',
  readAt: null,
  acknowledgedAt: null,
  supersededAt: null,
};

function harness(result: unknown) {
  const query = vi.fn(async (_base: string, _path: string, _input: unknown) => ({ result }));
  const mutate = vi.fn(async (_base: string, _path: string, _input: unknown) => ({ result }));
  return { workspaceId: 'recipient', apiBase: 'http://localhost', query, mutate };
}

describe('workspace mail tool boundaries', () => {
  it('strips full bodies from summary responses', async () => {
    const ports = harness({
      items: [{ ...summary, message: 'PRIVATE FULL BODY', body: 'PRIVATE FULL BODY' }],
      nextCursor: null,
      revision: 1,
    });
    const result = await callWorkspaceMailTool({
      ...ports,
      name: 'list_mail',
      args: { workspaceId: 'spoofed' },
    });
    expect(ports.query.mock.calls[0]?.[2]).toMatchObject({ workspaceId: 'recipient', limit: 20 });
    expect(result.content[0]?.text).not.toContain('PRIVATE FULL BODY');
    expect(result.content[0]?.text).toContain('Review ready');
  });

  it('rejects out-of-budget reads even when below the global ceiling', async () => {
    const ports = harness({
      items: [{ ...summary, body: '123456789', offset: 0, nextOffset: null }],
      revision: 1,
    });
    await expect(
      callWorkspaceMailTool({ ...ports, name: 'read_mail', args: { ids: ['mail-1'], maxChars: 8 } })
    ).rejects.toThrow('budget');
  });

  it('rejects invalid ID batches before making a backend request', async () => {
    const ports = harness({});
    await expect(
      callWorkspaceMailTool({
        ...ports,
        name: 'read_mail',
        args: { ids: Array.from({ length: 21 }, (_, i) => `mail-${i}`) },
      })
    ).rejects.toThrow();
    expect(ports.mutate).not.toHaveBeenCalled();
  });

  it('advertises bounded optional pagination and no recipient override', () => {
    const tool = WORKSPACE_MAIL_TOOLS.find(({ name }) => name === 'list_mail');
    expect(tool?.inputSchema.properties).not.toHaveProperty('workspaceId');
    expect(tool?.inputSchema.required ?? []).not.toContain('limit');
    expect(tool?.inputSchema.properties).toHaveProperty('cursor');
  });
});
