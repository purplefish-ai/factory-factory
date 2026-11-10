import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  type GitStatusFile,
  parseGitStatusOutput,
  parseNumstatOutput,
} from '@/backend/lib/git-helpers';
import {
  classifySharedGitEvent,
  isRefIndependentUpstreamFailure,
  normalizeRefName,
  refChangeAffects,
  revisionRefCandidates,
  type SharedGitEvent,
} from '@/backend/lib/git-shared-refs';
import { type ExecResult, gitCommand } from '@/backend/lib/shell';
import { decodeGitPath } from '@/shared/git-path';

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
  platform?: NodeJS.Platform;
}

/**
 * Normalized full names of the shared refs a snapshot read, or null when they
 * are unknown and every shared ref change must invalidate the snapshot.
 */
type RefDependencies = ReadonlySet<string> | null;

interface CacheEntry {
  snapshot: WorkspaceGitStateSnapshot;
  refDependencies: RefDependencies;
}

interface CalculatedSnapshot {
  snapshot: WorkspaceGitStateSnapshot;
  refDependencies: RefDependencies;
}

interface UpstreamCalculation {
  section: WorkspaceGitStateSnapshot['upstream'];
  /** Revisions the lookup and diff named; null when they are unknown. */
  revisions: string[] | null;
}

interface SnapshotCalculation {
  generation: number;
  failed: boolean;
  drained: Promise<void>;
  promise: Promise<WorkspaceGitStateSnapshot>;
  refresh?: { watcher: WatcherRecord; promise: Promise<WorkspaceGitStateSnapshot> };
}

interface WatcherRecord {
  worktreePath: string;
  mode: 'healthy' | 'fallback';
  handles: WatchHandle[];
  setup: Promise<void>;
  sharedDirectory?: string;
  /** The linked worktree's private Git directory, set with `sharedDirectory`. */
  gitDirectory?: string;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

interface SharedWatcherRecord {
  handle: WatchHandle;
  dependents: Set<string>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** Refs changed since the last flush; ignored when `pendingAll` is set. */
  pendingRefs: Set<string>;
  pendingAll: boolean;
}

interface WatchRoots {
  local: string[];
  shared?: { commonDirectory: string; gitDirectory: string };
}

// Bound individual snapshots as well as bursts across many workspaces.
const SNAPSHOT_GIT_CONCURRENCY = 3;
const SERVICE_GIT_CONCURRENCY = 6;
const WATCH_DEBOUNCE_MS = 100;
const DEGRADED_TTL_MS = 5000;
const FALLBACK_TTL_MS = 300_000;
const LINUX_TTL_MS = 5000;
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
    const [rawStatus, rawPath, rawDestinationPath] = line.split('\t');
    const filePath = decodeGitPath(rawPath ?? '');
    const destinationPath = rawDestinationPath ? decodeGitPath(rawDestinationPath) : undefined;
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
  if (snapshot.status.error) {
    return null;
  }
  return snapshot.base.stats;
}

export class WorkspaceGitStateService {
  private readonly runGit: RunGit;
  private readonly now: () => number;
  private readonly readFile: ReadFile;
  private readonly watchPath: WatchPath;
  private readonly recursiveWatch: boolean;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, SnapshotCalculation>();
  private readonly generations = new Map<string, number>();
  private readonly watchers = new Map<string, WatcherRecord>();
  private readonly sharedWatchers = new Map<string, SharedWatcherRecord>();
  private readonly watcherSuspensions = new Map<string, number>();

  constructor(options: WorkspaceGitStateServiceOptions = {}) {
    const executeGit = options.runGit ?? gitCommand;
    const limitGit = pLimit(SERVICE_GIT_CONCURRENCY);
    this.runGit = (args, cwd) => limitGit(() => executeGit(args, cwd));
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((filePath) => readFile(filePath, 'utf8'));
    this.watchPath = options.watchPath ?? defaultWatchPath;
    // Linux implements recursive fs.watch in JS, traversing even ignored
    // dependency trees. Keep watch installation independent of worktree size.
    this.recursiveWatch = (options.platform ?? platform()) !== 'linux';
  }

  getSnapshot(input: WorkspaceGitStateInput): Promise<WorkspaceGitStateSnapshot> {
    const normalizedInput = { ...input, worktreePath: path.resolve(input.worktreePath) };
    const watcher = this.ensureWatcher(normalizedInput.worktreePath);
    const key = this.cacheKey(normalizedInput);
    const cached = this.getCachedSnapshot(normalizedInput);
    if (cached) {
      return Promise.resolve(cached);
    }
    this.cache.delete(key);

    const existing = this.inFlight.get(key);
    const generation = this.generations.get(key) ?? 0;
    if (existing !== undefined) {
      if (existing.generation === generation && !existing.failed) {
        return existing.promise;
      }
      // Keep physical work registered until it settles. All readers following
      // invalidation share one fresh calculation, started after the old one.
      if (existing.refresh?.watcher !== watcher) {
        existing.refresh = {
          watcher,
          promise: existing.drained.then(() =>
            this.watchers.get(normalizedInput.worktreePath) === watcher
              ? this.getSnapshot(normalizedInput)
              : existing.promise
          ),
        };
      }
      return existing.refresh.promise;
    }

    const run = watcher.setup.then(() => this.calculate(normalizedInput, watcher));
    const outcome = run
      .then((started) => started.promise)
      .then(({ snapshot, refDependencies }) => {
        if ((this.generations.get(key) ?? 0) === generation) {
          this.cache.set(key, { snapshot, refDependencies });
        }
        return snapshot;
      });
    const calculation: SnapshotCalculation = {
      generation,
      failed: false,
      promise: outcome.then(
        (snapshot) => calculation.drained.then(() => snapshot),
        (error: unknown) => {
          calculation.failed = true;
          throw error;
        }
      ),
      drained: Promise.resolve(),
    };
    calculation.drained = Promise.allSettled([
      outcome,
      run.then((started) => started.drained),
    ]).then(() => {
      this.inFlight.delete(key);
      this.generations.delete(key);
    });
    this.inFlight.set(key, calculation);
    return calculation.promise;
  }

  /**
   * The cached snapshot for `input`, or null when there is none fresh enough
   * to serve.
   *
   * The read-only half of {@link getSnapshot}: same freshness rules, but it
   * never spawns `git` and never installs a watcher. Callers that must answer
   * now — a list query whose response would otherwise serialize a `git` run
   * per worktree — take this and treat a miss as "not known yet" rather than
   * blocking on the recompute.
   */
  getCachedSnapshot(input: WorkspaceGitStateInput): WorkspaceGitStateSnapshot | null {
    if (this.watcherSuspensions.has(path.resolve(input.worktreePath))) {
      return null;
    }
    const key = this.cacheKey({ ...input, worktreePath: path.resolve(input.worktreePath) });
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    // No watcher means nothing is invalidating this entry on change, so it only
    // holds for the fallback window — the same rule getSnapshot applies to a
    // watcher that failed to install.
    const watcher = this.watchers.get(path.resolve(input.worktreePath));
    const ttl = isDegraded(cached.snapshot)
      ? DEGRADED_TTL_MS
      : watcher?.mode === 'healthy'
        ? Number.POSITIVE_INFINITY
        : FALLBACK_TTL_MS;

    // Shallow Linux watches miss nested edits and refs. Readers already poll;
    // bound cache freshness even when every installed watch is healthy.
    const effectiveTtl = this.recursiveWatch ? ttl : Math.min(ttl, LINUX_TTL_MS);
    return this.now() - cached.snapshot.computedAt < effectiveTtl ? cached.snapshot : null;
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

  async withWatchersSuspended(worktreePath: string, operation: () => Promise<void>): Promise<void> {
    const normalizedPath = path.resolve(worktreePath);
    this.watcherSuspensions.set(
      normalizedPath,
      (this.watcherSuspensions.get(normalizedPath) ?? 0) + 1
    );
    this.remove(normalizedPath);
    try {
      await operation();
    } finally {
      const remaining = (this.watcherSuspensions.get(normalizedPath) ?? 1) - 1;
      if (remaining === 0) {
        this.watcherSuspensions.delete(normalizedPath);
      } else {
        this.watcherSuspensions.set(normalizedPath, remaining);
      }
      // Retire snapshots and fallback records created during deletion, including
      // failures. Only a later reader may install replacement watchers.
      this.remove(normalizedPath);
    }
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
    ]);
    for (const key of keys) {
      if (!shouldInvalidate(key)) {
        continue;
      }
      this.cache.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      if (!this.inFlight.has(key)) {
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
      worktreePath,
      mode: 'healthy',
      handles: [],
      setup: Promise.resolve(),
    };
    if (this.watcherSuspensions.has(worktreePath)) {
      record.mode = 'fallback';
    } else {
      record.setup = this.installWatchers(worktreePath, record).catch(() => {
        this.activateFallback(record);
      });
    }
    this.watchers.set(worktreePath, record);
    return record;
  }

  private async installWatchers(worktreePath: string, record: WatcherRecord): Promise<void> {
    const roots = await this.resolveWatchRoots(worktreePath);
    for (const root of roots.local) {
      if (record.mode !== 'healthy' || this.watchers.get(worktreePath) !== record) {
        return;
      }
      const handle = this.watchPath(
        root,
        { recursive: this.recursiveWatch },
        (_eventType, filename) => {
          if (root === worktreePath && shouldIgnoreWorktreeWatchEvent(filename)) {
            return;
          }
          this.scheduleInvalidation(worktreePath, record);
        }
      );
      record.handles.push(handle);
      handle.on('error', () => {
        this.activateFallback(record);
      });
    }
    if (roots.shared && record.mode === 'healthy' && this.watchers.get(worktreePath) === record) {
      this.attachSharedWatcher(roots.shared.commonDirectory, record);
      record.gitDirectory = roots.shared.gitDirectory;
    }
  }

  private async resolveWatchRoots(worktreePath: string): Promise<WatchRoots> {
    const local = [worktreePath];
    const dotGitPath = path.join(worktreePath, '.git');
    let dotGitContents: string;
    try {
      dotGitContents = await this.readFile(dotGitPath);
    } catch (error) {
      if (hasErrorCode(error, 'EISDIR')) {
        return { local };
      }
      throw error;
    }

    const gitDirMatch = dotGitContents.match(/^gitdir:\s*(.+)$/im);
    if (!gitDirMatch?.[1]) {
      throw new Error(`Invalid Git worktree metadata: ${dotGitPath}`);
    }
    const gitDir = path.resolve(path.dirname(dotGitPath), gitDirMatch[1].trim());
    local.push(gitDir);

    try {
      const commonDirContents = await this.readFile(path.join(gitDir, 'commondir'));
      const commonDir = commonDirContents.trim();
      if (commonDir) {
        return {
          local: [...new Set(local)],
          shared: { commonDirectory: path.resolve(gitDir, commonDir), gitDirectory: gitDir },
        };
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    return { local: [...new Set(local)] };
  }

  private attachSharedWatcher(commonDirectory: string, record: WatcherRecord): void {
    let shared = this.sharedWatchers.get(commonDirectory);
    if (!shared) {
      let created!: SharedWatcherRecord;
      const handle = this.watchPath(
        commonDirectory,
        { recursive: this.recursiveWatch },
        (_eventType, filename) => {
          const event = classifySharedGitEvent(filename);
          if (event.kind !== 'ignore') {
            this.scheduleSharedInvalidation(commonDirectory, created, event);
          }
        }
      );
      created = { handle, dependents: new Set(), pendingRefs: new Set(), pendingAll: false };
      shared = created;
      this.sharedWatchers.set(commonDirectory, shared);
      handle.on('error', () => {
        this.activateSharedFallback(commonDirectory, created);
      });
    }

    shared.dependents.add(record.worktreePath);
    record.sharedDirectory = commonDirectory;
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

  private scheduleSharedInvalidation(
    commonDirectory: string,
    record: SharedWatcherRecord,
    event: Exclude<SharedGitEvent, { kind: 'ignore' }>
  ): void {
    if (this.sharedWatchers.get(commonDirectory) !== record) {
      return;
    }
    if (event.kind === 'all') {
      record.pendingAll = true;
    } else {
      record.pendingRefs.add(event.ref);
    }
    if (record.debounceTimer) {
      clearTimeout(record.debounceTimer);
    }
    record.debounceTimer = setTimeout(() => {
      record.debounceTimer = undefined;
      const { pendingAll, pendingRefs } = record;
      record.pendingAll = false;
      record.pendingRefs = new Set();
      if (this.sharedWatchers.get(commonDirectory) !== record) {
        return;
      }
      if (pendingAll) {
        for (const worktreePath of record.dependents) {
          this.invalidate(worktreePath);
        }
        return;
      }
      this.invalidateForChangedRefs(record.dependents, pendingRefs);
    }, WATCH_DEBOUNCE_MS);
  }

  /**
   * Invalidate dependents' snapshots that read any changed ref. A key without
   * a cached snapshot may have a calculation running whose refs are not known
   * yet, so it is always fenced.
   */
  private invalidateForChangedRefs(
    worktreePaths: ReadonlySet<string>,
    changedRefs: ReadonlySet<string>
  ): void {
    this.invalidateMatching((key) => {
      if (!worktreePaths.has(key.slice(0, key.indexOf('\0')))) {
        return false;
      }
      const dependencies = this.cache.get(key)?.refDependencies;
      if (!dependencies) {
        return true;
      }
      for (const changedRef of changedRefs) {
        if (refChangeAffects(changedRef, dependencies)) {
          return true;
        }
      }
      return false;
    });
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
    this.detachSharedWatcher(record);
  }

  private detachSharedWatcher(record: WatcherRecord): void {
    const commonDirectory = record.sharedDirectory;
    record.sharedDirectory = undefined;
    record.gitDirectory = undefined;
    if (!commonDirectory) {
      return;
    }
    const shared = this.sharedWatchers.get(commonDirectory);
    if (!shared) {
      return;
    }
    shared.dependents.delete(record.worktreePath);
    if (shared.dependents.size === 0) {
      this.closeSharedWatcher(commonDirectory, shared);
    }
  }

  private activateSharedFallback(commonDirectory: string, record: SharedWatcherRecord): void {
    if (this.sharedWatchers.get(commonDirectory) !== record) {
      return;
    }
    this.closeSharedWatcher(commonDirectory, record);
    for (const worktreePath of record.dependents) {
      const watcher = this.watchers.get(worktreePath);
      if (watcher?.sharedDirectory === commonDirectory) {
        watcher.sharedDirectory = undefined;
        this.activateFallback(watcher);
      }
    }
    record.dependents.clear();
  }

  private closeSharedWatcher(commonDirectory: string, record: SharedWatcherRecord): void {
    if (this.sharedWatchers.get(commonDirectory) === record) {
      this.sharedWatchers.delete(commonDirectory);
    }
    if (record.debounceTimer) {
      clearTimeout(record.debounceTimer);
      record.debounceTimer = undefined;
    }
    try {
      record.handle.close();
    } catch {
      // Watcher cleanup is best effort; dependents still use fallback freshness.
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

  private calculate(
    input: WorkspaceGitStateInput,
    watcher: WatcherRecord
  ): {
    promise: Promise<CalculatedSnapshot>;
    drained: Promise<void>;
  } {
    const limitGit = pLimit(SNAPSHOT_GIT_CONCURRENCY);
    const commands: Promise<ExecResult>[] = [];
    const runGit: RunGit = (args, cwd) => {
      const command = limitGit(() => this.runGit(args, cwd));
      commands.push(command);
      return command;
    };
    // The revisions each command named, recorded as the commands are issued.
    const baseRevisions: string[] = [];
    const baseSection = this.calculateBase(input, runGit, baseRevisions);
    const upstreamCalculation = this.calculateUpstream(input.worktreePath, runGit);
    const sections = [
      runGit(
        ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'],
        input.worktreePath
      ),
      baseSection,
      upstreamCalculation,
      Promise.all([baseSection, upstreamCalculation]).then(
        ([, { revisions }]) =>
          revisions ? this.readRefDependencies(watcher, [...baseRevisions, ...revisions]) : null,
        () => null
      ),
    ] as const;
    const promise = Promise.all(sections).then(
      ([statusResult, base, { section: upstream }, refDependencies]) => {
        const statusFiles =
          statusResult.code === 0 ? parseGitStatusOutput(statusResult.stdout) : [];
        const status: WorkspaceGitStateSnapshot['status'] = {
          files: statusFiles,
          hasUncommitted: statusFiles.length > 0,
        };
        if (statusResult.code !== 0) {
          status.error = commandError(statusResult);
        }
        base.stats.hasUncommitted = status.hasUncommitted;
        const snapshot = { ...input, computedAt: this.now(), status, base, upstream };
        return { snapshot, refDependencies };
      }
    );
    // Report errors immediately, but keep ownership until every section and
    // its started commands settle. A failed base diff can outlive its section.
    const drained = Promise.allSettled(sections)
      .then(() => Promise.allSettled(commands))
      .then(() => undefined);
    return { promise, drained };
  }

  /**
   * The normalized shared refs a snapshot read: the branch its private HEAD
   * names, plus every full ref the named revisions could resolve to. Null
   * when that set cannot be established, including when a candidate is a
   * loose symbolic ref whose target could change without an event at its
   * own path. Packed refs are never symbolic.
   */
  private async readRefDependencies(
    watcher: WatcherRecord,
    revisions: string[]
  ): Promise<RefDependencies> {
    const { gitDirectory, sharedDirectory } = watcher;
    if (!(gitDirectory && sharedDirectory)) {
      return null;
    }
    try {
      const refs = revisions.flatMap(revisionRefCandidates);
      const head = (await this.readFile(path.join(gitDirectory, 'HEAD'))).trim();
      const headRef = head.match(/^ref:\s*(refs\/\S+)$/)?.[1];
      if (headRef) {
        refs.push(headRef);
      } else if (!/^[0-9a-f]{40,64}$/i.test(head)) {
        return null;
      }
      if (refs.some((ref) => ref.split('/').some((part) => part === '' || part === '..'))) {
        return null;
      }
      const symbolic = await Promise.all(
        refs.map((ref) => this.isLooseSymbolicRef(sharedDirectory, ref))
      );
      return symbolic.some(Boolean) ? null : new Set(refs.map(normalizeRefName));
    } catch {
      return null;
    }
  }

  private async isLooseSymbolicRef(commonDirectory: string, ref: string): Promise<boolean> {
    try {
      return (await this.readFile(path.join(commonDirectory, ref))).startsWith('ref:');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].some((code) => hasErrorCode(error, code))) {
        return false;
      }
      throw error;
    }
  }

  private async calculateBase(
    input: WorkspaceGitStateInput,
    runGit: RunGit,
    revisions?: string[]
  ): Promise<WorkspaceGitStateSnapshot['base'] & { stats: WorkspaceGitStats }> {
    const mergeBase = await this.findMergeBase(input, runGit, revisions);
    const diffArgs = mergeBase ? ['diff', '--numstat', mergeBase] : ['diff', '--numstat'];
    const diffs = [
      runGit(diffArgs, input.worktreePath),
      mergeBase ? runGit(['diff', '--name-status', mergeBase], input.worktreePath) : null,
    ] as const;
    const [numstatResult, nameStatusResult] = await Promise.all(diffs);
    const base: WorkspaceGitStateSnapshot['base'] & { stats: WorkspaceGitStats } = {
      mergeBase,
      noMergeBase: mergeBase === null,
      stats:
        numstatResult.code === 0
          ? { ...parseNumstatOutput(numstatResult.stdout), hasUncommitted: false }
          : { total: 0, additions: 0, deletions: 0, hasUncommitted: false },
      added: [],
      modified: [],
      deleted: [],
    };
    if (numstatResult.code !== 0) {
      base.statsError = commandError(numstatResult);
    }

    if (nameStatusResult) {
      if (nameStatusResult.code === 0) {
        Object.assign(base, parseNameStatus(nameStatusResult.stdout));
      } else {
        base.changesError = commandError(nameStatusResult);
      }
    }
    await this.populateFallbackFileTotal(
      base,
      numstatResult,
      nameStatusResult,
      input.worktreePath,
      runGit
    );
    return base;
  }

  private async populateFallbackFileTotal(
    base: WorkspaceGitStateSnapshot['base'] & { stats: WorkspaceGitStats },
    numstatResult: ExecResult,
    nameStatusResult: ExecResult | null,
    worktreePath: string,
    runGit: RunGit
  ): Promise<void> {
    if (numstatResult.code === 0) {
      return;
    }

    const fileListResult =
      nameStatusResult ?? (await runGit(['diff', '--name-only'], worktreePath));
    if (fileListResult.code === 0) {
      base.stats.total = fileListResult.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0).length;
    }
  }

  private async findMergeBase(
    input: WorkspaceGitStateInput,
    runGit: RunGit = this.runGit,
    revisions?: string[]
  ): Promise<string | null> {
    for (const candidate of [`origin/${input.defaultBranch}`, input.defaultBranch]) {
      revisions?.push(candidate);
      const result = await runGit(['merge-base', 'HEAD', candidate], input.worktreePath);
      if (result.code === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    }
    return null;
  }

  private async calculateUpstream(
    worktreePath: string,
    runGit: RunGit
  ): Promise<UpstreamCalculation> {
    const upstreamResult = await runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      worktreePath
    );
    const ref = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : '';
    if (!ref) {
      const refIndependent =
        upstreamResult.code !== 0 && isRefIndependentUpstreamFailure(upstreamResult.stderr);
      return {
        section: { ref: null, hasUpstream: false, files: [] },
        revisions: refIndependent ? [] : null,
      };
    }

    const diffResult = await runGit(['diff', '--name-only', `${ref}...HEAD`], worktreePath);
    if (diffResult.code !== 0) {
      return {
        section: { ref, hasUpstream: true, files: [], error: commandError(diffResult) },
        revisions: [ref],
      };
    }

    return {
      section: {
        ref,
        hasUpstream: true,
        files: diffResult.stdout
          .split('\n')
          .filter((line) => line.length > 0)
          .map(decodeGitPath),
      },
      revisions: [ref],
    };
  }
}

export const workspaceGitStateService = new WorkspaceGitStateService();
