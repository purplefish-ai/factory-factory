const WORD_LABELS: Record<string, string> = {
  github: 'GitHub',
  pr: 'PR',
  api: 'API',
  url: 'URL',
  id: 'ID',
  ui: 'UI',
  mcp: 'MCP',
};

function formatWord(word: string): string {
  const lower = word.toLowerCase();
  if (Object.hasOwn(WORD_LABELS, lower)) {
    return WORD_LABELS[lower] ?? word;
  }
  return /^[\p{Lu}\p{N}]{2,}s?$/u.test(word) ? word : lower;
}

function splitAcronymBoundary(
  match: string,
  leading: string,
  trailing: string,
  offset: number,
  value: string
): string {
  // URLs and IDs keep their plural suffix; JSONSchema still splits at Schema.
  const suffix = value.slice(offset + match.length);
  const plural = trailing.endsWith('s') && /^(?:$|[_-]|\p{Lu})/u.test(suffix);
  return plural ? match : `${leading} ${trailing}`;
}

function humanize(value: string): string {
  const canonical = value.toLowerCase();
  if (Object.hasOwn(WORD_LABELS, canonical)) {
    return WORD_LABELS[canonical] ?? value;
  }
  const words = value
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, splitAcronymBoundary)
    .replace(/([\p{Ll}\p{M}0-9])(\p{Lu})/gu, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/[\p{L}\p{N}]+/gu, formatWord)
    .trim()
    .replace(/\bpull request\b/g, 'PR');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Presentation only: the original identifier remains the tool's identity. */
export function getMcpToolDisplay(name: string): { action: string; service: string } | null {
  const normalized = name.trim();
  const parts = normalized.startsWith('mcp__')
    ? /^mcp__([^\s]+?)__(\S+)$/.exec(normalized)
    : /^mcp\.(?:codex_apps\.)?([^.\s]+)\.([^.\s]+)$/.exec(normalized);
  const server = parts?.[1];
  const tool = parts?.[2];
  if (!(server && tool && /[a-z0-9]/i.test(server) && /[a-z0-9]/i.test(tool))) {
    return null;
  }
  return {
    service: humanize(server),
    action:
      server === 'playwright' && tool === 'browser_take_screenshot'
        ? 'Take screenshot'
        : humanize(tool),
  };
}

export function isListFilesToolName(name: string): boolean {
  return /^list files(?:\s+in(?:\s|$)|$)/i.test(name.trim());
}
