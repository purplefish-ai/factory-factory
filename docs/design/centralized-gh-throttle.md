# Design: Centralized `gh` CLI Throttle

## Problem

Every `gh` CLI call spawns a child process that reads auth tokens from the macOS keyring and makes an HTTP request to GitHub's GraphQL/REST API. Currently, concurrency control is scattered across callers (scheduler `p-limit(5)`, ratchet `p-limit(20)`, `mapWithConcurrencyLimit(5)` in review requests), but these limits are independent — they don't know about each other. When the scheduler, ratchet, and user-triggered tRPC calls fire simultaneously, the actual process count can exceed any individual limit, causing:

1. **Keyring contention**: macOS keyring can't serve 20+ concurrent reads → silent failures (empty stderr, non-zero exit)
2. **GitHub API secondary rate limits**: Too many concurrent connections from the same token
3. **Misclassified errors**: These failures land in the `unknown` error bucket, logging noisy errors

## Current State: All `gh` Call Sites

All calls live in `GitHubCLIService` (`src/backend/services/github/service/github-cli.service.ts`). Each directly calls `execFileAsync('gh', ...)`.

### Call inventory

| Method | gh command | Timeout | Current concurrency control |
|---|---|---|---|
| `getAuthenticatedUsername()` | `gh api user` | 10s | None |
| `checkHealth()` | `gh --version` + `gh auth status` | 5s / 10s | None |
| `getPRStatus()` | `gh pr view --json ...` | 30s | Caller: scheduler `p-limit(5)`, ratchet `p-limit(20)` |
| `listReviewRequests()` | `gh search prs` + N × `gh pr view` | 30s / 10s | Internal: `mapWithConcurrencyLimit(5)` for detail fetches |
| `findPRForBranch()` | `gh pr list --head ...` | 30s | Caller: scheduler `p-limit(5)` |
| `approvePR()` | `gh pr review --approve` | 30s | None |
| `getPRFullDetails()` | `gh pr view --json (many fields)` | 30s | None |
| `getPRDiff()` | `gh pr diff` | 60s | None |
| `submitReview()` | `gh pr review` | 30s | None |
| `listIssues()` | `gh issue list` | 30s | None |
| `getReviewComments()` | `gh api repos/.../pulls/.../comments` | 30s | None |
| `addPRComment()` | `gh pr comment` | 30s | None |
| `addIssueComment()` | `gh issue comment` | 30s | None |
| `getIssue()` | `gh issue view` | 30s | None |
| `closeIssue()` | `gh issue close` | 30s | None |

### Caller chains that trigger concurrent bursts

```
Scheduler (every 3min)
├─ syncPRStatuses() ─ p-limit(5) ─→ N × getPRStatus()
└─ discoverNewPRs() ─ p-limit(5) ─→ N × findPRForBranch() + getPRStatus()

Ratchet (every 2min)
└─ runContinuousLoop() ─ p-limit(20) ─→ N × getPRStatus()

tRPC (user-triggered, any time)
├─ listIssuesForWorkspace → checkHealth() + getAuthenticatedUsername() + listIssues()
├─ listIssuesForProject   → checkHealth() + getAuthenticatedUsername() + listIssues()
└─ getIssue               → getIssue()
```

Worst case: scheduler (up to 10 concurrent) + ratchet (up to 20 concurrent) + user action = **30+ simultaneous `gh` processes**.

## Proposed Design: Single execution queue inside `GitHubCLIService`

### Core idea

Add a `p-limit` instance as a private member of `GitHubCLIService` and route **every** `execFileAsync('gh', ...)` call through it. Remove all caller-side concurrency controls (scheduler's `prSyncLimit`, ratchet's `checkLimit`, `mapWithConcurrencyLimit`).

### Implementation

```ts
// github-cli.service.ts
import pLimit from 'p-limit';

class GitHubCLIService {
  private readonly execLimit = pLimit(GH_CONCURRENCY);

  /**
   * All gh CLI calls go through this single gate.
   */
  private exec(
    args: string[],
    options?: { timeout?: number; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    return this.execLimit(() =>
      execFileAsync('gh', args, {
        timeout: options?.timeout ?? GH_TIMEOUT_MS.default,
        ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      })
    );
  }

  // Then every method just calls this.exec(...) instead of execFileAsync('gh', ...)
}
```

### Concurrency limit value

`GH_CONCURRENCY = 5` — add to `github-cli/constants.ts`.

Rationale:
- macOS keyring handles 5 concurrent reads reliably
- GitHub's secondary rate limit threshold is ~10 concurrent requests per token
- 5 keeps us well under both limits with headroom for user-triggered calls
- The scheduler and ratchet loops already run on intervals, so queuing a few extra seconds is fine

### What callers change

| Caller | Before | After |
|---|---|---|
| `scheduler.service.ts` | `pLimit(SERVICE_CONCURRENCY.schedulerPrSyncs)` wrapping each `syncSinglePR` / `discoverPRForWorkspace` | Remove `prSyncLimit` entirely; just `Promise.all(workspaces.map(...))` |
| `ratchet.service.ts` | `pLimit(SERVICE_CONCURRENCY.ratchetWorkspaceChecks)` wrapping each `checkWorkspace` | Remove `checkLimit` entirely; just `Promise.all(...)` |
| `SERVICE_CONCURRENCY` constant | `schedulerPrSyncs: 5`, `ratchetWorkspaceChecks: 20` | Remove both (or keep for non-gh concurrency if any) |
| `mapWithConcurrencyLimit` in `listReviewRequests()` | Hardcoded limit of 5 | Remove; detail fetches naturally throttled by `exec()` |
| `github-cli/utils.ts` | `mapWithConcurrencyLimit` helper | Delete if unused elsewhere |

### In-flight deduplication (singleflight)

The scheduler and ratchet run on independent timers (3min and 2min) and both call `getPRStatus()` for the same PR URLs. When their cycles overlap, the same `gh pr view 1364 --repo purplefish-ai/factory-factory --json ...` command gets spawned twice — identical args, identical result, wasted process slot.

We add a **singleflight map** alongside the concurrency limiter: if a `gh` call with identical arguments is already in-flight, return the same promise instead of enqueuing a new one.

```ts
class GitHubCLIService {
  private readonly execLimit = pLimit(GH_CONCURRENCY);
  private readonly inflight = new Map<string, Promise<{ stdout: string; stderr: string }>>();

  private exec(
    args: string[],
    options?: { timeout?: number; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    const key = args.join('\0');
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.execLimit(() =>
      execFileAsync('gh', args, {
        timeout: options?.timeout ?? GH_TIMEOUT_MS.default,
        ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      })
    ).finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }
}
```

**Key properties:**
- The dedup key is the full argument list joined by null bytes (args uniquely identify a gh call)
- The promise is removed from the map in `finally()`, so it only deduplicates truly concurrent calls — not a cache
- Read-only commands (`pr view`, `pr list`, `issue list`, `api`) are safe to deduplicate since they're idempotent
- Write commands (`pr review`, `pr comment`, `issue comment`, `issue close`) are NOT safe to deduplicate if called with the same args but different intent. However, these are only triggered by explicit user actions and are never called concurrently with identical args in practice

**Which calls benefit:**

| Overlap scenario | Shared call | Frequency |
|---|---|---|
| Scheduler `syncPRStatuses()` + Ratchet `checkWorkspace()` for same workspace | `gh pr view <N> --repo <R> --json ...` | Every time 2min and 3min cycles align (~every 6min) |
| Scheduler `discoverNewPRs()` discovers PR → `attachAndRefreshPR()` while Ratchet is also checking | `gh pr view <N> --repo <R> --json ...` | On PR discovery |
| tRPC `listIssuesForWorkspace` called multiple times rapidly (e.g., UI re-renders) | `gh api user`, `gh issue list` | On page navigation |

**What this does NOT replace:** The `p-limit` concurrency gate is still needed. Dedup only helps when the *exact same* command is in-flight. Different PR numbers, different repos — those are separate commands that still need throttling.

### Error classification fix (while we're here)

In `github-cli/errors.ts`, `isNetworkError()` misses `unexpected EOF` errors from GitHub's GraphQL endpoint:

```ts
function isNetworkError(message: string): boolean {
  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('unexpected eof')
  );
}
```

### Rate-limit backoff integration

`RateLimitBackoff` currently lives in the ratchet service. With centralized throttling, we could optionally move rate-limit awareness into the exec queue itself — when a 429 is detected, temporarily pause the queue. However, this is a separate concern and can be done as a follow-up. The current per-service backoff still works since it controls *how often* callers enqueue work, while the exec queue controls *how many run at once*.

## Files to change

| File | Change |
|---|---|
| `src/backend/services/github/service/github-cli.service.ts` | Add `execLimit`, add private `exec()` method, replace all `execFileAsync('gh', ...)` calls |
| `src/backend/services/github/service/github-cli/constants.ts` | Add `GH_CONCURRENCY = 5` |
| `src/backend/services/github/service/github-cli/errors.ts` | Add `unexpected eof` to `isNetworkError()` |
| `src/backend/services/github/service/github-cli/utils.ts` | Delete `mapWithConcurrencyLimit` (verify no other consumers first) |
| `src/backend/orchestration/scheduler.service.ts` | Remove `prSyncLimit` / `p-limit` import |
| `src/backend/services/ratchet/service/ratchet.service.ts` | Remove `checkLimit` / `p-limit` import for gh-related concurrency |
| `src/backend/services/constants.ts` | Remove `schedulerPrSyncs` and `ratchetWorkspaceChecks` from `SERVICE_CONCURRENCY` (or keep if used for non-gh work) |
| Tests for above files | Update mocks/assertions accordingly |

## Alternatives considered

1. **Token caching**: Cache the keyring token in memory and pass via `GH_TOKEN` env var to child processes. Avoids keyring contention but requires managing token refresh/expiry. More invasive.

2. **Serial queue (concurrency = 1)**: Simplest, but too slow when there are 20+ workspaces to poll. A 30s timeout × 20 workspaces = 10 minutes worst case.

3. **Keep distributed limits, but coordinate via shared semaphore**: More complex than a single queue for the same result. The `GitHubCLIService` singleton is already the natural chokepoint.
