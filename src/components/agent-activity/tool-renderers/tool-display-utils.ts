const SUMMARY_TOOL_NAME_MAX = 24;
const DETAIL_TOOL_NAME_MAX = 96;
const RUN_COMMAND_PREVIEW_MAX = 84;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

export function isRunLikeToolName(name: string): boolean {
  const normalized = normalizeWhitespace(name);
  return /^run(?:\s|$)/i.test(normalized);
}

export function extractCommandPreviewFromInput(input: Record<string, unknown>): string | null {
  const command = input.command;

  if (typeof command === 'string') {
    const normalized = normalizeWhitespace(command);
    return normalized || null;
  }

  if (Array.isArray(command)) {
    const stringParts = command.filter((part): part is string => typeof part === 'string');
    if (stringParts.length === 0) {
      return null;
    }

    const shellFlagIndex = stringParts.findIndex((part) => part === '-c' || part === '-lc');
    if (shellFlagIndex >= 0 && shellFlagIndex < stringParts.length - 1) {
      const script = normalizeWhitespace(stringParts[shellFlagIndex + 1] ?? '');
      if (script) {
        return script;
      }
    }

    const joined = normalizeWhitespace(stringParts.join(' '));
    return joined || null;
  }

  return null;
}

export function getDisplayToolName(
  name: string,
  input: Record<string, unknown>,
  options: { summary?: boolean } = {}
): string {
  const normalizedName = normalizeWhitespace(name);
  if (!normalizedName) {
    return 'Tool';
  }

  if (isRunLikeToolName(normalizedName)) {
    if (options.summary) {
      return 'Run';
    }
    const commandPreview = extractCommandPreviewFromInput(input);
    if (!commandPreview) {
      return 'Run';
    }
    return truncateWithEllipsis(`Run ${commandPreview}`, RUN_COMMAND_PREVIEW_MAX);
  }

  return truncateWithEllipsis(
    normalizedName,
    options.summary ? SUMMARY_TOOL_NAME_MAX : DETAIL_TOOL_NAME_MAX
  );
}
