const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Map canonical matches back to the original graphemes for display/copy. */
export function highlightSearchText(
  text: string,
  query: string
): { start: number; text: string; matched: boolean }[] {
  const words = query
    .normalize('NFC')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!words.length) {
    return [{ start: 0, text, matched: false }];
  }
  let normalized = '';
  const ranges = Array.from(segmenter.segment(text), ({ index, segment }) => {
    const start = normalized.length;
    normalized += segment.normalize('NFC');
    return { start, end: normalized.length, rawStart: index, rawEnd: index + segment.length };
  });
  const expression = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts: { start: number; text: string; matched: boolean }[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(new RegExp(expression, 'giu'))) {
    const start = ranges.find((range) => range.end > match.index)?.rawStart;
    const end = ranges.find((range) => range.end >= match.index + match[0].length)?.rawEnd;
    if (start === undefined || end === undefined || start < cursor) {
      continue;
    }
    if (start > cursor) {
      parts.push({ start: cursor, text: text.slice(cursor, start), matched: false });
    }
    parts.push({ start, text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push({ start: cursor, text: text.slice(cursor), matched: false });
  }
  return parts;
}
