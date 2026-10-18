# Git snapshot command scheduling

`WorkspaceGitStateService` starts status, merge-base resolution, and upstream
resolution independently. Base diffs wait for merge-base resolution; the
upstream diff waits for its upstream ref. Status continues to use
`--no-optional-locks`. Each snapshot runs at most three Git commands at once,
and the service runs at most six across all workspaces, including standalone
merge-base requests.

The local-default-branch fallback remains sequential after an unsuccessful
`origin/<defaultBranch>` merge-base lookup. Missing merge bases skip base change
metadata. Failed numstat commands reuse the existing name-status result for a
file count; only snapshots without a merge base issue a fallback name-only diff.
Rejected command promises still reject the snapshot and do not populate its
cache. Rejection is immediate: sibling reads already running or queued may
finish their dependency chains. Both concurrency limits still apply, including
across an immediate retry. These reads cannot restore the failed snapshot's
cache entry, and later sibling rejections remain handled. The runner does not
expose cancellation; allowing bounded read-only work to settle avoids
introducing a separate cancellation lifecycle. Watchers, cache TTLs, in-flight
coalescing, and invalidation generations retain their existing behavior.

## Reproduce the measurement

Use the repository's pinned Node and pnpm versions:

```sh
pnpm exec tsx scripts/benchmark-git-snapshots.ts
```

This creates a disposable repository with 1,000 generated files plus
`committed.txt` (1,001 tracked files), a main branch, a feature commit, a local
upstream, and tracked and untracked changes, then removes it. To measure an
existing repository without changing it:

```sh
pnpm exec tsx scripts/benchmark-git-snapshots.ts /absolute/path/to/repo main
```

The explicit repository must remain unchanged during measurement. No mode runs
fetch or accesses a remote. The benchmark alternates execution order over 25
pairs after three warm-up pairs. It compares the production scheduler with the
same commands serialized at the Git runner boundary, checks complete snapshot
equality apart from `computedAt`, and reports cache misses, cache hits, and
command counts. Cached reads must issue zero commands. Inert watchers keep
invalidation timing repeatable while retaining real Git metadata discovery.

The serialized adapter isolates command concurrency rather than comparing
separate application revisions. Results depend on repository size, storage, Git
configuration, filesystem caches, and competing processes. These numbers measure
service cache misses with warm filesystem caches, not cold disk access.

## Observed results

On 2026-10-17, Node 26.8.1 and Apple Git 2.54.0 produced these median times over
25 alternating pairs after three warm-up pairs:

| Measurement                                          | Sequential | Bounded concurrency |
| ---------------------------------------------------- | ---------: | ------------------: |
| Application repository, actual pre-change revision   |  181.81 ms |            80.54 ms |
| Disposable 1,001-file repository, serialized adapter |  103.64 ms |            38.53 ms |
| Application repository, cached read                  |  0.0184 ms |           0.0160 ms |
| Disposable repository, cached read                   |  0.0147 ms |           0.0142 ms |

The application comparison loaded the pre-change service from
`fc30bb563ef4d0dc66ca8e30a0ea4f87b640ecd6` in a temporary directory and ran both
implementations against the same unchanged repository. All paired snapshots were
equal. Each variant issued six Git commands per cache miss (168 including
warm-up runs), and cached reads issued none. Shared-host load was not isolated;
these measurements are indicative rather than performance thresholds.
