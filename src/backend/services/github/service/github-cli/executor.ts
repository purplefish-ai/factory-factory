import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isNetworkErrorMessage, isRateLimitMessage } from '@/backend/services/rate-limit-backoff';
import { GH_TIMEOUT_MS, ghExecLimit } from './constants';

const execFileAsync = promisify(execFile);
const RATE_LIMIT_FAST_FAIL_MS = 60_000;
const NETWORK_FAST_FAIL_MS = 30_000;
type ExecResult = { stdout: string; stderr: string };
type ExecOptions = { timeout?: number; maxBuffer?: number; signal?: AbortSignal };

/** Shared process budget, read singleflight, and temporary outage protection. */
export class GitHubCLIExecutor {
  private readonly inflight = new Map<string, Promise<ExecResult>>();
  private rateLimitedUntil = 0;
  private networkFailure: { error: unknown; until: number } | null = null;

  clearBackoff(): void {
    this.rateLimitedUntil = 0;
    this.networkFailure = null;
  }

  read(args: string[], options?: ExecOptions): Promise<ExecResult> {
    // Signal-bound reads own their process and cancellation independently.
    if (options?.signal) {
      return this.execute(args, options, true);
    }
    const key = args.join('\0');
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const promise = this.execute(args, options, true).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  mutate(args: string[], options?: Omit<ExecOptions, 'signal'>): Promise<ExecResult> {
    // Never deduplicate or automatically replay a write with an ambiguous outcome.
    return this.execute(args, options, false);
  }

  private throwIfUnavailable(networkRead: boolean): void {
    if (Date.now() < this.rateLimitedUntil) {
      throw new Error('GitHub API rate limit exceeded, backing off');
    }
    if (networkRead && this.networkFailure && Date.now() < this.networkFailure.until) {
      throw this.networkFailure.error;
    }
  }

  private async execute(
    args: string[],
    options: ExecOptions | undefined,
    read: boolean
  ): Promise<ExecResult> {
    const networkRead = read && args[0] !== '--version';
    options?.signal?.throwIfAborted();
    this.throwIfUnavailable(networkRead);
    return await ghExecLimit(async () => {
      options?.signal?.throwIfAborted();
      // An outage may have started while this command waited for a process slot.
      this.throwIfUnavailable(networkRead);
      try {
        return await execFileAsync('gh', args, {
          timeout: options?.timeout ?? GH_TIMEOUT_MS.default,
          ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // Record backoff before releasing the process slot to the next command.
        if (!options?.signal?.aborted) {
          this.recordFailure(error, networkRead);
        }
        throw error;
      }
    });
  }

  private recordFailure(error: unknown, networkRead: boolean): void {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (isRateLimitMessage(message)) {
      this.rateLimitedUntil = Date.now() + RATE_LIMIT_FAST_FAIL_MS;
      return;
    }
    if (!(networkRead && isNetworkErrorMessage(message))) {
      return;
    }
    if (!this.networkFailure || Date.now() >= this.networkFailure.until) {
      this.networkFailure = { error, until: Date.now() + NETWORK_FAST_FAIL_MS };
    }
  }
}
