import { describe, expect, it, vi } from 'vitest';
import { searchRouter } from './search.trpc';

const search = vi.fn().mockResolvedValue([]);
const caller = searchRouter.createCaller({
  appContext: {
    services: {
      metadataSearchService: { search },
    },
  },
} as never);

describe('metadata search boundary', () => {
  it('provides bounded defaults and trims input', async () => {
    await expect(caller.metadata({ query: '  branch  ' })).resolves.toEqual([]);
    expect(search).toHaveBeenCalledWith({ query: 'branch', limit: 30, includeArchived: false });
  });
  it.each([{ query: 'x'.repeat(201) }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }])(
    'rejects invalid input %j',
    async (input) => {
      await expect(caller.metadata(input)).rejects.toThrow();
      expect(search).not.toHaveBeenCalled();
    }
  );
});
