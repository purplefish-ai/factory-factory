import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { CommandInfo } from '@/shared/acp-protocol';

function parseCommandDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      return '';
    }
    const descLine = match[1]?.split(/\r?\n/).find((line) => line.startsWith('description:'));
    return descLine ? descLine.slice('description:'.length).trim() : '';
  } catch {
    return '';
  }
}

function isRealPathContainedInRoot(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal);
  return !(rel.startsWith('..') || isAbsolute(rel));
}

function resolveContainedRegularFile(rootReal: string, filePath: string): string | null {
  try {
    const fileReal = realpathSync(filePath);
    if (!isRealPathContainedInRoot(rootReal, fileReal)) {
      return null;
    }
    if (!statSync(fileReal).isFile()) {
      return null;
    }
    return fileReal;
  } catch {
    return null;
  }
}

export function commandNameKey(name: string): string {
  const normalized = name.trim().replace(/^\/+/, '');
  return normalized.replace(/^(?:project|workspace|user):/, '');
}

export function isWorkspaceScopedCommandName(name: string): boolean {
  const normalized = name.trim().replace(/^\/+/, '');
  const colonIndex = normalized.indexOf(':');
  if (colonIndex < 0) {
    return false;
  }
  const scope = normalized.slice(0, colonIndex);
  return scope === 'project' || scope === 'workspace';
}

/** Hears each directory before it is listed and each command file before it is read. */
type ScanObserver = (path: string) => void;

function scanCommandsFromDir(
  dir: string,
  seen: Set<string>,
  containmentRoot = dir,
  namespace = '',
  observe?: ScanObserver
): CommandInfo[] {
  observe?.(dir);
  let files: Dirent[];
  let rootReal: string;
  try {
    rootReal = realpathSync(containmentRoot);
    const dirReal = realpathSync(dir);
    if (!isRealPathContainedInRoot(rootReal, dirReal)) {
      return [];
    }
    files = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: CommandInfo[] = [];
  for (const file of files) {
    const filePath = join(dir, file.name);
    if (file.isDirectory()) {
      commands.push(
        ...scanCommandsFromDir(
          filePath,
          seen,
          containmentRoot,
          `${namespace}${file.name}:`,
          observe
        )
      );
      continue;
    }
    if (!file.name.endsWith('.md')) {
      continue;
    }
    observe?.(filePath);
    const fileReal = resolveContainedRegularFile(rootReal, filePath);
    if (!fileReal) {
      continue;
    }
    const name = `${namespace}${basename(file.name, '.md')}`;
    const key = name;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push({ name, description: parseCommandDescription(fileReal) });
  }
  return commands;
}

export function scanClaudeGlobalCommandsFromDisk(seen = new Set<string>()): CommandInfo[] {
  return scanCommandsFromDir(join(homedir(), '.claude', 'commands'), seen);
}

/**
 * `observe` hears every directory listed and command file read: adding, removing
 * or renaming an entry changes its directory's `stat`, and editing a file (or a
 * link target appearing) changes the file's.
 */
export function scanClaudeWorkspaceCommandsFromDisk(
  worktreePath: string | null,
  seen = new Set<string>(),
  observe?: ScanObserver
): CommandInfo[] {
  if (!worktreePath) {
    return [];
  }
  return scanCommandsFromDir(
    join(worktreePath, '.claude', 'commands'),
    seen,
    worktreePath,
    '',
    observe
  );
}

/** A path's state as `stat` sees it through links; null when it cannot be read. */
function pathStamp(path: string): string | null {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stats ? `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}` : null;
  } catch {
    return null;
  }
}

const MAX_CACHED_WORKSPACES = 64;

/**
 * Workspace commands per worktree, rescanned only when a stamp of a directory it
 * listed or a command file it read has changed, so an unchanged workspace costs
 * one `stat` per directory and command file instead of a scan.
 */
export class WorkspaceCommandScanCache {
  private readonly entries = new Map<
    string,
    { commands: CommandInfo[]; stamps: [path: string, stamp: string | null][] }
  >();

  constructor(
    private readonly scanFromDisk = scanClaudeWorkspaceCommandsFromDisk,
    private readonly maxEntries = MAX_CACHED_WORKSPACES
  ) {}

  /** Same result as `scanClaudeWorkspaceCommandsFromDisk`, in fresh objects. */
  scan(worktreePath: string | null, seen = new Set<string>()): CommandInfo[] {
    if (!worktreePath) {
      return [];
    }
    let entry = this.entries.get(worktreePath);
    this.entries.delete(worktreePath);
    if (!entry?.stamps.every(([path, stamp]) => pathStamp(path) === stamp)) {
      const stamps: [string, string | null][] = [];
      const commands = this.scanFromDisk(worktreePath, new Set(), (path) => {
        stamps.push([path, pathStamp(path)]);
      });
      entry = { commands, stamps };
    }
    this.entries.set(worktreePath, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) {
        break;
      }
      this.entries.delete(oldest);
    }
    const commands: CommandInfo[] = [];
    for (const command of entry.commands) {
      if (!seen.has(command.name)) {
        seen.add(command.name);
        commands.push({ ...command });
      }
    }
    return commands;
  }
}

export const workspaceCommandScanCache = new WorkspaceCommandScanCache();
