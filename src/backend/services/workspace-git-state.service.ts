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
    error?: string;
  };
  upstream: {
    ref: string | null;
    hasUpstream: boolean;
    files: string[];
    error?: string;
  };
}

type RunGit = (args: string[], cwd: string) => Promise<ExecResult>;

interface WorkspaceGitStateServiceOptions {
  runGit?: RunGit;
  now?: () => number;
}

interface CacheEntry {
  snapshot: WorkspaceGitStateSnapshot;
}

function commandError(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim() || 'Git command failed';
}

function parseNameStatus(
  output: string
): Pick<WorkspaceGitStateSnapshot['base'], 'added' | 'modified' | 'deleted'> {
  const added: WorkspaceGitStateSnapshot['base']['added'] = [];
  const modified: WorkspaceGitStateSnapshot['base']['modified'] = [];
  const deleted: WorkspaceGitStateSnapshot['base']['deleted'] = [];

  for (const line of output.split('\n')) {
    const [status, filePath] = line.split('\t');
    if (!filePath) {
      continue;
    }
    if (status === 'A') {
      added.push({ path: filePath, status: 'added' });
    }
    if (status === 'M') {
      modified.push({ path: filePath, status: 'modified' });
    }
    if (status === 'D') {
      deleted.push({ path: filePath, status: 'deleted' });
    }
  }

  return { added, modified, deleted };
}

export function getStats(snapshot: WorkspaceGitStateSnapshot): WorkspaceGitStats | null {
  if (snapshot.status.error || snapshot.base.error) {
    return null;
  }
  return snapshot.base.stats;
}

export class WorkspaceGitStateService {
  private readonly runGit: RunGit;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<WorkspaceGitStateSnapshot>>();
  private readonly generations = new Map<string, number>();

  constructor(options: WorkspaceGitStateServiceOptions = {}) {
    this.runGit = options.runGit ?? gitCommand;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(input: WorkspaceGitStateInput): Promise<WorkspaceGitStateSnapshot> {
    const normalizedInput = { ...input, worktreePath: path.resolve(input.worktreePath) };
    const key = this.cacheKey(normalizedInput);
    const cached = this.cache.get(key);
    if (cached) {
      return Promise.resolve(cached.snapshot);
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const generation = this.generations.get(key) ?? 0;
    const calculation = this.calculate(normalizedInput)
      .then((snapshot) => {
        const hasError = snapshot.status.error || snapshot.base.error || snapshot.upstream.error;
        if ((this.generations.get(key) ?? 0) === generation && !hasError) {
          this.cache.set(key, { snapshot });
        }
        return snapshot;
      })
      .finally(() => {
        if (this.inFlight.get(key) === calculation) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, calculation);
    return calculation;
  }

  invalidate(worktreePath: string): void {
    const keyPrefix = `${path.resolve(worktreePath)}\0`;
    const keys = new Set([
      ...this.cache.keys(),
      ...this.inFlight.keys(),
      ...this.generations.keys(),
    ]);
    for (const key of keys) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      this.cache.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
  }

  remove(worktreePath: string): void {
    const keyPrefix = `${path.resolve(worktreePath)}\0`;
    this.invalidate(worktreePath);
    for (const key of [...this.inFlight.keys(), ...this.generations.keys()]) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      this.inFlight.delete(key);
    }
  }

  stop(): void {
    for (const key of this.inFlight.keys()) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
    this.cache.clear();
    this.inFlight.clear();
  }

  private cacheKey(input: WorkspaceGitStateInput): string {
    return `${input.worktreePath}\0${input.defaultBranch}`;
  }

  private async calculate(input: WorkspaceGitStateInput): Promise<WorkspaceGitStateSnapshot> {
    const statusResult = await this.runGit(['status', '--porcelain'], input.worktreePath);
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
      base.error = commandError(numstatResult);
    }

    if (mergeBase) {
      const nameStatusResult = await this.runGit(
        ['diff', '--name-status', mergeBase],
        input.worktreePath
      );
      if (nameStatusResult.code === 0) {
        Object.assign(base, parseNameStatus(nameStatusResult.stdout));
      } else {
        base.error ??= commandError(nameStatusResult);
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
