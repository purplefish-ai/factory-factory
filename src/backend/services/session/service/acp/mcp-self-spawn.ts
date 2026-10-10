/**
 * Self-spawn resolution for MCP server subprocesses
 * (`child-workspace-mcp-server.ts`, `workspace-wake-mcp-server.ts`). Each
 * server is both an MCP server entry point (run as a subprocess) and the
 * module AcpRuntimeManager imports to obtain its own spawn config.
 *
 * Modern Node parses an entry file's TypeScript syntax directly, but it
 * resolves relative imports literally — a `.js`-specifier sibling import only
 * resolves to a sibling `.ts` file through a TypeScript-aware loader. From
 * source (dev, where `import.meta.url` points at the `.ts` file), the
 * subprocess re-launches through the local `tsx` binary so sibling imports
 * resolve; from the built dist (where the sibling is itself `.js`), plain
 * Node resolves it directly.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_PROJECT_ROOT_SEARCH_DEPTH = 20;

function findProjectRoot(startDir: string): string | null {
  let currentDir = startDir;
  for (let depth = 0; depth < MAX_PROJECT_ROOT_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(currentDir, 'package.json'))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
  return null;
}

/** Resolves the command to re-launch an MCP server module as its own subprocess. */
export function resolveMcpServerSpawnCommand(selfPath: string): {
  command: string;
  args: string[];
} {
  if (selfPath.endsWith('.ts')) {
    const projectRoot = findProjectRoot(dirname(selfPath));
    const tsxBin = projectRoot
      ? join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
      : null;
    if (tsxBin && existsSync(tsxBin)) {
      return { command: tsxBin, args: [selfPath] };
    }
  }
  return { command: process.execPath, args: [selfPath] };
}
