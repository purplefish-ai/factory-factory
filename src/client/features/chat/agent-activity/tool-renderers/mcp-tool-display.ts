const WORD_LABELS: Record<string, string> = {
  github: 'GitHub',
  pr: 'PR',
  api: 'API',
  url: 'URL',
  id: 'ID',
  ui: 'UI',
  mcp: 'MCP',
};

function humanize(value: string): string {
  const canonical = value.toLowerCase();
  if (Object.hasOwn(WORD_LABELS, canonical)) {
    return WORD_LABELS[canonical] ?? value;
  }
  // Match acronym plurals before the ordinary camel-case word boundary.
  const tokens =
    value.match(
      /[A-Z]{2,}s(?=[A-Z_-]|$)|[A-Z]+(?=[A-Z][a-z]|[^a-zA-Z]|$)|[A-Z]?[a-z]+|[0-9]+|[^a-zA-Z0-9_-]+/g
    ) ?? [];
  const words = tokens
    .map((word) => {
      const lower = word.toLowerCase();
      if (Object.hasOwn(WORD_LABELS, lower)) {
        return WORD_LABELS[lower];
      }
      return /^[A-Z]{2,}s?$/.test(word) ? word : lower;
    })
    .join(' ')
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
