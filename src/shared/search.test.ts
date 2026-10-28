import { describe, expect, it } from 'vitest';
import { SearchResultSchema } from './search';

describe('search result identities', () => {
  it('rejects missing conversation and workspace navigation ids', () => {
    const base = { id: 'one', title: 'One', subtitle: '', projectSlug: 'project', archived: false };
    expect(
      SearchResultSchema.safeParse({ ...base, kind: 'session', workspaceId: 'ws', sessionId: null })
        .success
    ).toBe(false);
    expect(
      SearchResultSchema.safeParse({
        ...base,
        kind: 'workspace',
        workspaceId: null,
        sessionId: null,
      }).success
    ).toBe(false);
  });
});
