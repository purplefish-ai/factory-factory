import { describe, expect, it } from 'vitest';
import {
  ackMailInputSchema,
  listMailInputSchema,
  readMailInputSchema,
  readMailResultSchema,
  workspaceMailSendMetadataSchema,
} from './workspace-mail';

describe('workspace mail bounds', () => {
  it.each(['progress', 'PROGRES'])('rejects invalid mail kind %s', (kind) => {
    expect(workspaceMailSendMetadataSchema.safeParse({ kind }).success).toBe(false);
  });
  it('bounds task revisions to the Prisma integer range', () => {
    expect(workspaceMailSendMetadataSchema.parse({ taskRevision: 2_147_483_647 })).toEqual({
      taskRevision: 2_147_483_647,
    });
    expect(workspaceMailSendMetadataSchema.safeParse({ taskRevision: 2_147_483_648 }).success).toBe(
      false
    );
  });
  it('allows omitted subjects and trims nonblank subjects while rejecting empty subjects', () => {
    expect(workspaceMailSendMetadataSchema.parse({})).toEqual({});
    expect(workspaceMailSendMetadataSchema.parse({ subject: ' Ready ' })).toEqual({
      subject: 'Ready',
    });
    expect(workspaceMailSendMetadataSchema.safeParse({ subject: '' }).success).toBe(false);
    expect(workspaceMailSendMetadataSchema.safeParse({ subject: ' \t ' }).success).toBe(false);
  });
  it('defaults bounded list and read operations and rejects oversized IDs/budgets', () => {
    expect(listMailInputSchema.parse({ workspaceId: 'w' }).limit).toBe(20);
    expect(readMailInputSchema.parse({ workspaceId: 'w', ids: ['a'] })).toMatchObject({
      maxChars: 8192,
      offset: 0,
    });
    expect(listMailInputSchema.safeParse({ workspaceId: 'w', limit: 51 }).success).toBe(false);
    expect(listMailInputSchema.safeParse({ workspaceId: 'w', kinds: [] }).success).toBe(false);
    expect(
      readMailInputSchema.safeParse({ workspaceId: 'w', ids: Array(21).fill('a') }).success
    ).toBe(false);
    expect(
      readMailInputSchema.safeParse({ workspaceId: 'w', ids: ['a'], maxChars: 16_385 }).success
    ).toBe(false);
    expect(
      ackMailInputSchema.safeParse({ workspaceId: 'w', ids: ['a'], throughRevision: -1 }).success
    ).toBe(false);
    expect(workspaceMailSendMetadataSchema.safeParse({ taskKey: ' ' }).success).toBe(false);
  });
  it('bounds total result body text across selected messages and validates serialized timestamps', () => {
    const item = {
      id: 'a',
      revision: 1,
      subject: null,
      preview: '',
      kind: 'MESSAGE',
      taskKey: null,
      taskRevision: null,
      sourceWorkspaceId: 's',
      sourceWorkspaceName: 'S',
      sourceProjectName: 'P',
      createdAt: '2026-11-02T00:00:00.000Z',
      readAt: null,
      acknowledgedAt: null,
      supersededAt: null,
      body: 'x'.repeat(8193),
      offset: 0,
      nextOffset: null,
    };
    expect(
      readMailResultSchema.safeParse({ items: [item, { ...item, id: 'b' }], revision: 2 }).success
    ).toBe(false);
    const parsed = readMailResultSchema.parse({ items: [item], revision: 1 });
    expect(parsed.items[0]?.createdAt).toBeInstanceOf(Date);
  });
});
