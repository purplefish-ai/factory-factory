/** Plain-text thinking previews share formatting while the popup preserves paragraphs. */
export function formatThinkingText(input: string | null | undefined): string {
  const source = input ?? '';
  const code: string[] = [];
  let marker = '\u0000thinking-code:';
  // Select a marker absent from the source so literal input cannot collide with a placeholder.
  while (source.includes(marker)) {
    marker = `\u0000${marker}`;
  }
  const protectCode = (text: string): string => {
    const index = code.push(text) - 1;
    return `${marker}${index}\u0000`;
  };
  // Protect complete or streaming fences before spans, including literal separators and emphasis.
  const protectedText = source
    .replace(
      /^ {0,3}(`{3,})[^`\n]*\n([\s\S]*?)(?:^ {0,3}\1`*[ \t]*(?=\r?$)|(?![\s\S]))|^ {0,3}(~{3,})[^\n]*\n([\s\S]*?)(?:^ {0,3}\3~*[ \t]*(?=\r?$)|(?![\s\S]))/gm,
      (
        _match,
        _backticks: string | undefined,
        backtickText: string | undefined,
        _tildes: string | undefined,
        tildeText: string | undefined
      ) => protectCode(backtickText ?? tildeText ?? '')
    )
    .replace(/`([^`\n]+)`/g, (_match, text: string) => protectCode(text));
  return stripThinkingMarkdown(protectedText)
    .replace(
      new RegExp(`${marker}(\\d+)\u0000`, 'g'),
      (match, index: string) => code[Number(index)] ?? match
    )
    .trim();
}

function stripThinkingMarkdown(input: string): string {
  let text = input
    .replace(/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove complete nested emphasis before considering unfinished streaming markers.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/(?<!\w)(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1(?!\w)/g, '$2');
  } while (text !== previous);
  return (
    text
      .replace(/`/g, '')
      // Hide incomplete streaming emphasis without stripping intraword punctuation or bullets.
      .replace(/(?<!\w)[*_~`]{2,}(?=[^\s*_~`])/g, '')
      .replace(/[*_~]+(?=\s*$)/g, '')
      .replace(/^[\s`*~_]+$/g, '')
  );
}

/** Ignore marker-only paragraphs when choosing the current work to show inline. */
export function getLatestThinkingParagraph(input: string | null | undefined): string | undefined {
  return formatThinkingText(input)
    .split(/\n\s*\n/)
    .reverse()
    .find((paragraph) => paragraph.trim().length > 0);
}
