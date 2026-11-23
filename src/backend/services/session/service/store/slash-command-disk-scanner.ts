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

type PathStamp = { path: string; stamp: string | null; changedNs: bigint };

/** A path's state as `stat` sees it through links; a null stamp when it cannot be read. */
function stampPath(path: string): PathStamp {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stats
      ? {
          path,
          stamp: `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
          changedNs: stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs,
        }
      : { path, stamp: null, changedNs: 0n };
  } catch {
    return { path, stamp: null, changedNs: 0n };
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const MAX_CACHED_WORKSPACES = 64;
/**
 * A change this close to a scan may share its timestamps with the next change
 * (Linux stamps files from a coarse clock, other filesystems to the second), so
 * such a scan is not reused.
 */
const RACY_WINDOW_MS = 2000;

/**
 * Workspace commands per worktree, rescanned only when the worktree resolves
 * elsewhere or a stamp of a directory it listed or a command file it read has
 * changed, so an unchanged workspace costs one `stat` per directory and command
 * file instead of a scan.
 */
export class WorkspaceCommandScanCache {
  private readonly entries = new Map<
    string,
    { root: string | null; commands: CommandInfo[]; stamps: PathStamp[] }
  >();
  private readonly scanFromDisk: typeof scanClaudeWorkspaceCommandsFromDisk;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    options: {
      scanFromDisk?: typeof scanClaudeWorkspaceCommandsFromDisk;
      maxEntries?: number;
      now?: () => number;
    } = {}
  ) {
    this.scanFromDisk = options.scanFromDisk ?? scanClaudeWorkspaceCommandsFromDisk;
    this.maxEntries = options.maxEntries ?? MAX_CACHED_WORKSPACES;
    this.now = options.now ?? Date.now;
  }

  /** Same result as `scanClaudeWorkspaceCommandsFromDisk`, in fresh objects. */
  scan(worktreePath: string | null, seen = new Set<string>()): CommandInfo[] {
    if (!worktreePath) {
      return [];
    }
    const root = realpathOrNull(worktreePath);
    const cached = this.entries.get(worktreePath);
    this.entries.delete(worktreePath);
    let commands = cached?.commands;
    if (
      !(
        cached &&
        cached.root === root &&
        cached.stamps.every(({ path, stamp }) => stampPath(path).stamp === stamp)
      )
    ) {
      const scannedAtNs = BigInt(this.now()) * 1_000_000n;
      const stamps: PathStamp[] = [];
      commands = this.scanFromDisk(worktreePath, new Set(), (path) => {
        stamps.push(stampPath(path));
      });
      const settledNs = scannedAtNs - BigInt(RACY_WINDOW_MS) * 1_000_000n;
      if (stamps.every(({ changedNs }) => changedNs < settledNs)) {
        this.entries.set(worktreePath, { root, commands, stamps });
      }
    } else {
      this.entries.set(worktreePath, cached);
    }
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) {
        break;
      }
      this.entries.delete(oldest);
    }
    const fresh: CommandInfo[] = [];
    for (const command of commands ?? []) {
      if (!seen.has(command.name)) {
        seen.add(command.name);
        fresh.push({ ...command });
      }
    }
    return fresh;
  }
}

export const workspaceCommandScanCache = new WorkspaceCommandScanCache();
