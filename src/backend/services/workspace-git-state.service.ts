import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type GitStatusFile,
  parseGitStatusOutput,
  parseNumstatOutput,
} from '@/backend/lib/git-helpers';
import { type ExecResult, gitCommand } from '@/backend/lib/shell';

export interface WorkspaceGitStateInput {
  worktreePath: string;
  defaultBranch: string;
}

export interface WorkspaceGitStats {
  total: number;
  additions: number;
  deletions: number;
  hasUncommitted: boolean;
}

export interface WorkspaceGitStateSnapshot {
  worktreePath: string;
  defaultBranch: string;
  computedAt: number;
  status: {
    files: GitStatusFile[];
    hasUncommitted: boolean;
    error?: string;
  };
  base: {
    mergeBase: string | null;
    noMergeBase: boolean;
    stats: WorkspaceGitStats | null;
    added: Array<{ path: string; status: 'added' }>;
    modified: Array<{ path: string; status: 'modified' }>;
    deleted: Array<{ path: string; status: 'deleted' }>;
    statsError?: string;
    changesError?: string;
  };
  upstream: {
    ref: string | null;
    hasUpstream: boolean;
    files: string[];
    error?: string;
  };
}

type RunGit = (args: string[], cwd: string) => Promise<ExecResult>;
type ReadFile = (filePath: string) => Promise<string>;

interface WatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): WatchHandle;
}

type WatchPath = (
  filePath: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | null) => void
) => WatchHandle;

interface WorkspaceGitStateServiceOptions {
  runGit?: RunGit;
  now?: () => number;
  readFile?: ReadFile;
  watchPath?: WatchPath;
}

interface CacheEntry {
  snapshot: WorkspaceGitStateSnapshot;
}

interface WatcherRecord {
  mode: 'healthy' | 'fallback';
  handles: WatchHandle[];
  setup: Promise<void>;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

const WATCH_DEBOUNCE_MS = 100;
const DEGRADED_TTL_MS = 5000;
const FALLBACK_TTL_MS = 300_000;
const IGNORED_WORKTREE_WATCH_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  '.turbo',
  'coverage',
]);

const defaultWatchPath: WatchPath = (filePath, options, listener) =>
  watch(filePath, options, (eventType, filename) => {
    listener(eventType, filename?.toString() ?? null);
  });

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function commandError(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim() || 'Git command failed';
}

function isDegraded(snapshot: WorkspaceGitStateSnapshot): boolean {
  return Boolean(
    snapshot.status.error ||
      snapshot.base.statsError ||
      snapshot.base.changesError ||
      snapshot.upstream.error
  );
}

function shouldIgnoreWorktreeWatchEvent(filename: string | null): boolean {
  if (!filename) {
    return false;
  }

  const [topLevelDirectory] = filename.split(/[\\/]+/);
  return IGNORED_WORKTREE_WATCH_DIRECTORIES.has(topLevelDirectory ?? '');
}

function parseNameStatus(
  output: string
): Pick<WorkspaceGitStateSnapshot['base'], 'added' | 'modified' | 'deleted'> {
  const added: WorkspaceGitStateSnapshot['base']['added'] = [];
  const modified: WorkspaceGitStateSnapshot['base']['modified'] = [];
  const deleted: WorkspaceGitStateSnapshot['base']['deleted'] = [];

  for (const line of output.split('\n')) {
    const [rawStatus, filePath, destinationPath] = line.split('\t');
    if (!filePath) {
      continue;
    }
    const status = rawStatus?.[0];
    switch (status) {
      case 'A':
        added.push({ path: filePath, status: 'added' });
        break;
      case 'M':
      case 'T':
        modified.push({ path: filePath, status: 'modified' });
        break;
      case 'D':
        deleted.push({ path: filePath, status: 'deleted' });
        break;
      case 'R':
        deleted.push({ path: filePath, status: 'deleted' });
        if (destinationPath) {
          added.push({ path: destinationPath, status: 'added' });
        }
        break;
      case 'C':
        if (destinationPath) {
          added.push({ path: destinationPath, status: 'added' });
        }
        break;
    }
  }

  return { added, modified, deleted };
}

export function getStats(snapshot: WorkspaceGitStateSnapshot): WorkspaceGitStats | null {
  if (snapshot.status.error || snapshot.base.statsError) {
    return null;
  }
  return snapshot.base.stats;
}

export class WorkspaceGitStateService {
  private readonly runGit: RunGit;
  private readonly now: () => number;
  private readonly readFile: ReadFile;
  private readonly watchPath: WatchPath;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<WorkspaceGitStateSnapshot>>();
  private readonly generations = new Map<string, number>();
  private readonly activeCalculations = new Map<string, number>();
  private readonly watchers = new Map<string, WatcherRecord>();

  constructor(options: WorkspaceGitStateServiceOptions = {}) {
    this.runGit = options.runGit ?? gitCommand;
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((filePath) => readFile(filePath, 'utf8'));
    this.watchPath = options.watchPath ?? defaultWatchPath;
  }

  getSnapshot(input: WorkspaceGitStateInput): Promise<WorkspaceGitStateSnapshot> {
    const normalizedInput = { ...input, worktreePath: path.resolve(input.worktreePath) };
    const watcher = this.ensureWatcher(normalizedInput.worktreePath);
    const key = this.cacheKey(normalizedInput);
    const cached = this.cache.get(key);
    if (cached) {
      const ttl = isDegraded(cached.snapshot)
        ? DEGRADED_TTL_MS
        : watcher.mode === 'healthy'
          ? Number.POSITIVE_INFINITY
          : FALLBACK_TTL_MS;
      if (this.now() - cached.snapshot.computedAt < ttl) {
        return Promise.resolve(cached.snapshot);
      }
    }
    if (cached) {
      this.cache.delete(key);
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const generation = this.generations.get(key) ?? 0;
    this.activeCalculations.set(key, (this.activeCalculations.get(key) ?? 0) + 1);
    const calculation = watcher.setup
      .then(() => this.calculate(normalizedInput))
      .then((snapshot) => {
        if ((this.generations.get(key) ?? 0) === generation) {
          this.cache.set(key, { snapshot });
        }
        return snapshot;
      })
      .finally(() => {
        if (this.inFlight.get(key) === calculation) {
          this.inFlight.delete(key);
        }
        const activeCount = this.activeCalculations.get(key) ?? 0;
        if (activeCount <= 1) {
          this.activeCalculations.delete(key);
          this.generations.delete(key);
        } else {
          this.activeCalculations.set(key, activeCount - 1);
        }
      });
    this.inFlight.set(key, calculation);
    return calculation;
  }

  getMergeBase(input: WorkspaceGitStateInput): Promise<string | null> {
    return this.findMergeBase({ ...input, worktreePath: path.resolve(input.worktreePath) });
  }

  invalidate(worktreePath: string): void {
    this.invalidatePath(path.resolve(worktreePath));
  }

  invalidateAll(): void {
    this.invalidateMatching(() => true);
  }

  remove(worktreePath: string): void {
    const normalizedPath = path.resolve(worktreePath);
    this.closeWatcher(normalizedPath);
    this.invalidatePath(normalizedPath);
  }

  stop(): void {
    for (const worktreePath of [...this.watchers.keys()]) {
      this.closeWatcher(worktreePath);
    }

    this.invalidateAll();
  }

  getCachedSnapshotCount(): number {
    return this.cache.size;
  }

  getGenerationCount(): number {
    return this.generations.size;
  }

  private invalidatePath(worktreePath: string): void {
    const keyPrefix = `${worktreePath}\0`;
    this.invalidateMatching((key) => key.startsWith(keyPrefix));
  }

  private invalidateMatching(shouldInvalidate: (key: string) => boolean): void {
    const keys = new Set([
      ...this.cache.keys(),
      ...this.inFlight.keys(),
      ...this.generations.keys(),
      ...this.activeCalculations.keys(),
    ]);
    for (const key of keys) {
      if (!shouldInvalidate(key)) {
        continue;
      }
      this.cache.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      this.inFlight.delete(key);
      if (!this.activeCalculations.has(key)) {
        this.generations.delete(key);
      }
    }
  }

  private cacheKey(input: WorkspaceGitStateInput): string {
    return `${input.worktreePath}\0${input.defaultBranch}`;
  }

  private ensureWatcher(worktreePath: string): WatcherRecord {
    const existing = this.watchers.get(worktreePath);
    if (existing) {
      return existing;
    }

    const record: WatcherRecord = {
      mode: 'healthy',
      handles: [],
      setup: Promise.resolve(),
    };
    record.setup = this.installWatchers(worktreePath, record).catch(() => {
      this.activateFallback(record);
    });
    this.watchers.set(worktreePath, record);
    return record;
  }

  private async installWatchers(worktreePath: string, record: WatcherRecord): Promise<void> {
    const roots = await this.resolveWatchRoots(worktreePath);
    for (const root of roots) {
      if (record.mode !== 'healthy' || this.watchers.get(worktreePath) !== record) {
        return;
      }
      const handle = this.watchPath(root, { recursive: true }, (_eventType, filename) => {
        if (root === worktreePath && shouldIgnoreWorktreeWatchEvent(filename)) {
          return;
        }
        this.scheduleInvalidation(worktreePath, record);
      });
      record.handles.push(handle);
      handle.on('error', () => {
        this.activateFallback(record);
      });
    }
  }

  private async resolveWatchRoots(worktreePath: string): Promise<string[]> {
    const roots = [worktreePath];
    const dotGitPath = path.join(worktreePath, '.git');
    let dotGitContents: string;
    try {
      dotGitContents = await this.readFile(dotGitPath);
    } catch (error) {
      if (hasErrorCode(error, 'EISDIR')) {
        return roots;
      }
      throw error;
    }

    const gitDirMatch = dotGitContents.match(/^gitdir:\s*(.+)$/im);
    if (!gitDirMatch?.[1]) {
      throw new Error(`Invalid Git worktree metadata: ${dotGitPath}`);
    }
    const gitDir = path.resolve(path.dirname(dotGitPath), gitDirMatch[1].trim());
    roots.push(gitDir);

    try {
      const commonDirContents = await this.readFile(path.join(gitDir, 'commondir'));
      const commonDir = commonDirContents.trim();
      if (commonDir) {
        roots.push(path.resolve(gitDir, commonDir));
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    return [...new Set(roots)];
  }

  private scheduleInvalidation(worktreePath: string, record: WatcherRecord): void {
    if (record.mode !== 'healthy' || this.watchers.get(worktreePath) !== record) {
      return;
    }
    if (record.debounceTimer) {
      clearTimeout(record.debounceTimer);
    }
    record.debounceTimer = setTimeout(() => {
      record.debounceTimer = undefined;
      if (record.mode === 'healthy' && this.watchers.get(worktreePath) === record) {
        this.invalidate(worktreePath);
      }
    }, WATCH_DEBOUNCE_MS);
  }

  private activateFallback(record: WatcherRecord): void {
    record.mode = 'fallback';
    if (record.debounceTimer) {
      clearTimeout(record.debounceTimer);
      record.debounceTimer = undefined;
    }
    for (const handle of record.handles.splice(0)) {
      try {
        handle.close();
      } catch {
        // Watcher cleanup is best effort; fallback freshness still protects callers.
      }
    }
  }

  private closeWatcher(worktreePath: string): void {
    const record = this.watchers.get(worktreePath);
    if (!record) {
      return;
    }
    this.watchers.delete(worktreePath);
    this.activateFallback(record);
  }

  private async calculate(input: WorkspaceGitStateInput): Promise<WorkspaceGitStateSnapshot> {
    const statusResult = await this.runGit(
      ['--no-optional-locks', 'status', '--porcelain'],
      input.worktreePath
    );
    const statusFiles = statusResult.code === 0 ? parseGitStatusOutput(statusResult.stdout) : [];
    const status: WorkspaceGitStateSnapshot['status'] = {
      files: statusFiles,
      hasUncommitted: statusFiles.length > 0,
    };
    if (statusResult.code !== 0) {
      status.error = commandError(statusResult);
    }

    const mergeBase = await this.findMergeBase(input);
    const diffArgs = mergeBase ? ['diff', '--numstat', mergeBase] : ['diff', '--numstat'];
    const numstatResult = await this.runGit(diffArgs, input.worktreePath);
    const base: WorkspaceGitStateSnapshot['base'] = {
      mergeBase,
      noMergeBase: mergeBase === null,
      stats:
        numstatResult.code === 0
          ? { ...parseNumstatOutput(numstatResult.stdout), hasUncommitted: status.hasUncommitted }
          : null,
      added: [],
      modified: [],
      deleted: [],
    };
    if (numstatResult.code !== 0) {
      base.statsError = commandError(numstatResult);
    }

    if (mergeBase) {
      const nameStatusResult = await this.runGit(
        ['diff', '--name-status', mergeBase],
        input.worktreePath
      );
      if (nameStatusResult.code === 0) {
        Object.assign(base, parseNameStatus(nameStatusResult.stdout));
      } else {
        base.changesError = commandError(nameStatusResult);
      }
    }

    const upstream = await this.calculateUpstream(input.worktreePath);
    return {
      ...input,
      computedAt: this.now(),
      status,
      base,
      upstream,
    };
  }

  private async findMergeBase(input: WorkspaceGitStateInput): Promise<string | null> {
    for (const candidate of [`origin/${input.defaultBranch}`, input.defaultBranch]) {
      const result = await this.runGit(['merge-base', 'HEAD', candidate], input.worktreePath);
      if (result.code === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    }
    return null;
  }

  private async calculateUpstream(
    worktreePath: string
  ): Promise<WorkspaceGitStateSnapshot['upstream']> {
    const upstreamResult = await this.runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      worktreePath
    );
    const ref = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : '';
    if (!ref) {
      return { ref: null, hasUpstream: false, files: [] };
    }

    const diffResult = await this.runGit(['diff', '--name-only', `${ref}...HEAD`], worktreePath);
    if (diffResult.code !== 0) {
      return {
        ref,
        hasUpstream: true,
        files: [],
        error: commandError(diffResult),
      };
    }

    return {
      ref,
      hasUpstream: true,
      files: diffResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
  }
}

export const workspaceGitStateService = new WorkspaceGitStateService();
