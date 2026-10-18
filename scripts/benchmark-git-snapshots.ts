/**
 * Run with pnpm exec tsx scripts/benchmark-git-snapshots.ts [repo] [defaultBranch].
 * With no repo, creates and removes a disposable fixture. An explicit repo is
 * read only: no fetch, checkout, config writes, or optional status locks.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execCommand, type ExecResult, gitCommand } from '@/backend/lib/shell';
import { WorkspaceGitStateService } from '@/backend/services/workspace-git-state.service';

async function createFixture(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'git-snapshot-benchmark-'));
  const git = async (args: string[]) => {
    const result = await gitCommand(
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
      cwd
    );
    assert.equal(result.code, 0, result.stderr);
  };
  try {
    await git(['init', '-b', 'main']);
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(
        Array.from({ length: 50 }, (_, offset) => {
          const i = batch * 50 + offset;
          return writeFile(path.join(cwd, `file-${i}.txt`), `file ${i}\n`.repeat(100));
        })
      );
    }
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Benchmark',
      '-c',
      'user.email=benchmark@example.test',
      'commit',
      '-m',
      'Fixture',
    ]);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(['switch', '-c', 'feature']);
    // A local upstream exercises the upstream diff without any remote requests.
    await git(['branch', '--set-upstream-to=main']);
    await writeFile(path.join(cwd, 'committed.txt'), 'committed change\n');
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Benchmark',
      '-c',
      'user.email=benchmark@example.test',
      'commit',
      '-m',
      'Feature',
    ]);
    await writeFile(path.join(cwd, 'file-0.txt'), 'modified\n');
    await writeFile(path.join(cwd, 'untracked.txt'), 'untracked\n');
    return cwd;
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

function measuredService(serial: boolean) {
  let commands = 0;
  let tail = Promise.resolve();
  const service = new WorkspaceGitStateService({
    // Keep real metadata discovery, but use inert watchers for repeatable timing.
    watchPath: () => ({
      close() {
        /* No real watcher to close. */
      },
      on() {
        return this;
      },
    }),
    runGit: (args, cwd) => {
      const execute = () => {
        commands++;
        return gitCommand(args, cwd);
      };
      if (!serial) {
        return execute();
      }
      const result: Promise<ExecResult> = tail.then(execute);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  });
  return { service, commandCount: () => commands };
}

function summary(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    samples: times.length,
  };
}

async function measureRead(
  measured: ReturnType<typeof measuredService>,
  input: { worktreePath: string; defaultBranch: string }
) {
  const { service, commandCount } = measured;
  service.invalidate(input.worktreePath);
  let start = performance.now();
  const snapshot = await service.getSnapshot(input);
  const missMs = performance.now() - start;
  const before = commandCount();
  start = performance.now();
  assert.equal(await service.getSnapshot(input), snapshot);
  const hitMs = performance.now() - start;
  assert.equal(commandCount(), before, 'cache hit spawned Git');
  return { snapshot: { ...snapshot, computedAt: 0 }, missMs, hitMs };
}

async function main() {
  const requestedRepo = process.argv[2];
  const disposable = !requestedRepo;
  const worktreePath = requestedRepo ? path.resolve(requestedRepo) : await createFixture();
  const input = { worktreePath, defaultBranch: process.argv[3] ?? 'main' };
  const sequential = measuredService(true);
  const parallel = measuredService(false);
  const variants = { sequential, parallel };
  const cold = { sequential: [] as number[], parallel: [] as number[] };
  const cached = { sequential: [] as number[], parallel: [] as number[] };
  try {
    for (let i = 0; i < 28; i++) {
      const order =
        i % 2 ? (['parallel', 'sequential'] as const) : (['sequential', 'parallel'] as const);
      const snapshots = [];
      for (const variant of order) {
        const observed = await measureRead(variants[variant], input);
        if (i >= 3) {
          cold[variant].push(observed.missMs);
          cached[variant].push(observed.hitMs);
        }
        snapshots.push(observed.snapshot);
      }
      assert.deepEqual(snapshots[0], snapshots[1], 'snapshot changed between paired runs');
    }
    const gitVersion = await execCommand('git', ['--version']);
    console.log(
      JSON.stringify(
        {
          node: process.version,
          git: gitVersion.stdout.trim(),
          fixture: disposable ? 'disposable:1001-files' : worktreePath,
          cacheMiss: { sequential: summary(cold.sequential), parallel: summary(cold.parallel) },
          cached: { sequential: summary(cached.sequential), parallel: summary(cached.parallel) },
          commandCountsIncludingWarmup: {
            sequential: sequential.commandCount(),
            parallel: parallel.commandCount(),
          },
          pairedSnapshotsEqual: true,
        },
        null,
        2
      )
    );
  } finally {
    sequential.service.stop();
    parallel.service.stop();
    if (disposable) {
      await rm(worktreePath, { recursive: true, force: true });
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
