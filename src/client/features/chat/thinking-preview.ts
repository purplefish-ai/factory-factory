/** Plain-text thinking previews share formatting while the popup preserves paragraphs. */
export function formatThinkingText(input: string | null | undefined): string {
  const source = input ?? '';
  const code: string[] = [];
  let marker = '\u0000thinking-code:';
  // Select a marker absent from the source so literal input cannot collide with a placeholder.
  while (source.includes(marker)) {
    marker = `\u0000${marker}`;
  }
  // Protect code while cleaning the whole string, including emphasis and links around spans.
  const protectedText = source.replace(/`([^`\n]+)`/g, (_match, text: string) => {
    const index = code.push(text) - 1;
    return `${marker}${index}\u0000`;
  });
  return stripThinkingMarkdown(protectedText)
    .replace(
      new RegExp(`${marker}(\\d+)\u0000`, 'g'),
      (match, index: string) => code[Number(index)] ?? match
    )
    .trim();
}

function stripThinkingMarkdown(input: string): string {
  let text = input.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove complete nested emphasis before considering unfinished streaming markers.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/(?<!\w)(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1(?!\w)/g, '$2');
  } while (text !== previous);
  return (
    text
      // Hide incomplete streaming emphasis without stripping intraword punctuation or bullets.
      .replace(/(?<!\w)[*_~`]{2,}(?=[^\s*_~`])/g, '')
      .replace(/^[\s`*~_]+$/g, '')
  );
}
