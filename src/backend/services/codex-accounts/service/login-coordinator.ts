import type { CodexLoginState } from '@/shared/codex-accounts';
import { adoptLoginStage, createLoginStage, discardLoginStage } from './profile';
import { hasVerifiedScope } from './types';
import type { AccountIdentity, AccountRow, CodexRuntimeContext, NativeLogin } from './types';
interface LoginEntry {
  accountId: string;
  abort: AbortController;
  done: Promise<void>;
  stage?: CodexRuntimeContext;
}
export class LoginCoordinator {
  private states = new Map<string, CodexLoginState>();
  private active?: LoginEntry;
  constructor(
    private readonly dependencies: {
      resolve(
        id: string,
        signal: AbortSignal
      ): Promise<{ row: AccountRow; context: CodexRuntimeContext }>;
      prepare(id: string, signal: AbortSignal): Promise<void>;
      probe(context: CodexRuntimeContext, signal: AbortSignal): Promise<AccountIdentity>;
      verify(id: string, identity: AccountIdentity, persist: boolean): Promise<void>;
      login: NativeLogin;
      invalidate(): void;
    }
  ) {}
  isPending(id: string): boolean {
    return this.active?.accountId === id;
  }
  private ensureActive(entry: LoginEntry): void {
    if (entry.abort.signal.aborted || this.active !== entry) {
      throw new Error('Codex login cancelled');
    }
  }
  private async cancellable<T>(entry: LoginEntry, work: Promise<T>): Promise<T> {
    const signal = entry.abort.signal;
    let aborted!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(new Error('Codex login cancelled'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        aborted();
      }
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  }
  start(id: string): Promise<CodexLoginState> {
    if (this.active) {
      if (this.active.accountId === id) {
        return Promise.resolve(this.status(id));
      }
      return Promise.reject(new Error('Another Codex browser login is in progress'));
    }
    // Reserve the latch before the first await so cancel/shutdown also covers IO preparation.
    const entry: LoginEntry = {
      accountId: id,
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = entry;
    this.states.set(id, { accountId: id, status: 'pending' });
    const timer = setTimeout(() => entry.abort.abort(), 5 * 60_000);
    timer.unref?.();
    const preparation = (async () => {
      const resolved = await this.cancellable(
        entry,
        this.dependencies.resolve(id, entry.abort.signal)
      );
      this.ensureActive(entry);
      if (resolved.row.kind === 'NATIVE_DEFAULT') {
        throw new Error(
          'Reconnect the native default account through the native Codex CLI; browser re-login is supported for managed accounts only'
        );
      }
      await this.cancellable(entry, this.dependencies.prepare(id, entry.abort.signal));
      this.ensureActive(entry);
      entry.stage = await createLoginStage(resolved.context);
      this.ensureActive(entry);
      return resolved.context;
    })();
    entry.done = preparation
      .then(async (target) => {
        const stage = entry.stage;
        if (!stage) {
          throw new Error('Codex login stage unavailable');
        }
        await this.dependencies.login(stage, entry.abort.signal, (authorizationUrl) => {
          if (!entry.abort.signal.aborted && this.active === entry) {
            this.states.set(id, { accountId: id, status: 'pending', authorizationUrl });
          }
        });
        this.ensureActive(entry);
        // Native login and identity probe both close their owned process before adoption.
        const identity = await this.dependencies.probe(stage, entry.abort.signal);
        this.ensureActive(entry);
        if (!(identity.authenticated && hasVerifiedScope(identity))) {
          throw new Error('Codex staged account identity unavailable');
        }
        await this.dependencies.verify(id, identity, false);
        this.ensureActive(entry);
        // Persist the verified identity before the file commit point. A failed
        // adoption can leave a safely pinned signed-out row; a database failure
        // must never replace the original native credentials.
        await this.dependencies.verify(id, identity, true);
        this.ensureActive(entry);
        await adoptLoginStage(stage, target, entry.abort.signal);
        return { accountId: id, status: 'completed' } satisfies CodexLoginState;
      })
      .catch((): CodexLoginState => ({
        accountId: id,
        status: entry.abort.signal.aborted ? 'cancelled' : 'failed',
        message: entry.abort.signal.aborted
          ? 'Login cancelled or timed out'
          : 'Login failed. Use the original, distinct account; existing profile credentials were preserved.',
      }))
      .then(async (outcome) => {
        clearTimeout(timer);
        if (entry.stage) {
          await discardLoginStage(entry.stage).catch(() => undefined);
        }
        if (this.active === entry) {
          this.active = undefined;
        }
        // Publish the outcome only once the account is usable again, so callers
        // that react to a finished login never hit the pending-login guard.
        this.states.set(id, outcome);
        this.dependencies.invalidate();
      });
    return preparation.then(() => this.status(id));
  }
  status(id: string): CodexLoginState {
    return (
      this.states.get(id) ?? { accountId: id, status: 'failed', message: 'No login in progress' }
    );
  }
  async cancel(id: string): Promise<CodexLoginState> {
    const active = this.active;
    if (active?.accountId === id) {
      active.abort.abort();
      await active.done;
    }
    return this.status(id);
  }
  async shutdown(): Promise<void> {
    if (this.active) {
      await this.cancel(this.active.accountId);
    }
  }
}
