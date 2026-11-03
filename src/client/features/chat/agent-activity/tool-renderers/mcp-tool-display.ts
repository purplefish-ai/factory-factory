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
  const words = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\bpull request\b/g, 'PR')
    .split(/\s+/)
    .map((word) => (Object.hasOwn(WORD_LABELS, word) ? WORD_LABELS[word] : word))
    .join(' ');
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
