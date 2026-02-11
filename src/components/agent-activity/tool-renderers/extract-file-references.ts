import type { FileReference } from '@/components/agent-activity/types';

/**
 * Known tools that operate on files and their input field names.
 */
const FILE_TOOL_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  Bash: ['command'],
};

/**
 * Extracts file references from tool input.
 */
export function extractFileReferences(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>
): FileReference[] {
  const references: FileReference[] = [];
  const fields = FILE_TOOL_FIELDS[toolName];

  if (!fields) {
    return references;
  }

  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.startsWith('/')) {
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      references.push({
        path: value,
        lineStart: typeof offset === 'number' ? offset : undefined,
        lineEnd:
          typeof offset === 'number' && typeof limit === 'number' ? offset + limit : undefined,
        toolName,
        toolCallId: toolId,
      });
    }
  }

  return references;
}
