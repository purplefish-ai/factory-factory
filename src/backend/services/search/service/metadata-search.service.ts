import type { z } from 'zod';
import { metadataSearchAccessor } from '@/backend/services/search/resources/metadata-search.accessor';
import { SearchInputSchema, SearchResultSchema } from '@/shared/search';

export const metadataSearchService = {
  async search(input: z.input<typeof SearchInputSchema>) {
    const parsed = SearchInputSchema.parse(input);
    const query = parsed.query.replace(/\s+/g, ' ').normalize('NFC').toLowerCase();
    const candidates = await metadataSearchAccessor.search({
      ...parsed,
      query,
    });
    const words = query.split(' ').filter(Boolean);
    const results = candidates.filter((result) => {
      const text = result.searchText.normalize('NFC').toLowerCase();
      return words.every((word) => text.includes(word));
    });
    results.sort(
      (a, b) =>
        score(b.title, query) - score(a.title, query) ||
        b.updatedAt - a.updatedAt ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id)
    );
    return results.slice(0, parsed.limit).map((result) => SearchResultSchema.parse(result));
  },
};

function score(title: string, query: string): number {
  if (!query) {
    return 0;
  }
  const normalized = title.normalize('NFC').toLowerCase();
  if (normalized === query) {
    return 100;
  }
  if (normalized.startsWith(query)) {
    return 80;
  }
  return normalized.includes(query) ? 60 : 20;
}
