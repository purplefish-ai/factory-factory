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
    return candidates.map((result) =>
      SearchResultSchema.parse({
        ...result,
        matchSnippet: matchedSnippet(result, query),
      })
    );
  },
};

function matchedSnippet(
  result: { title: string; subtitle: string; snippetText: string },
  query: string
): string | null {
  const visible = `${result.title} ${result.subtitle}`.normalize('NFC').toLowerCase();
  const missing = query.split(' ').find((word) => word && !visible.includes(word));
  if (!missing) {
    return null;
  }
  const source = result.snippetText.normalize('NFC');
  const text = (
    source.split(/\r?\n/).find((line) => line.toLowerCase().includes(missing)) ?? source
  ).replace(/\s+/g, ' ');
  const index = text.toLowerCase().indexOf(missing);
  if (index < 0) {
    return null;
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 140);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
