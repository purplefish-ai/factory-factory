import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import { timeLaunchDiscovery } from '../acp/launch-discovery-timing';
type Input = { provider: 'CLAUDE' | 'CODEX'; model?: string; codexAccountId?: string };
type Defaults = {
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
};
const CACHE_FRESH_MS = 5 * 60_000;
const CACHE_MAX_AGE_MS = 30 * 60_000;
const REFRESH_RETRY_MS = 30_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_PENDING_DISCOVERIES = 8;
const logger = createLogger('session-launch-options');
type Discovery = { result: Promise<SessionLaunchOptions>; drained: Promise<void> };
type PendingDiscovery = Discovery & { succeeded: boolean };
export class SessionLaunchOptionsService {
  private readonly cache = new Map<
    string,
    { value: SessionLaunchOptions; capturedAt: number; refreshAfter: number }
  >();
  private readonly pending = new Map<string, PendingDiscovery>();
  constructor(
    private readonly deps: {
      fetchOptions(input: Input): Promise<Discovery>;
      getSettings(): Promise<Defaults>;
      resolveAccountId?(input: Input): Promise<string>;
    }
  ) {}
  getOptions(input: Input): Promise<SessionLaunchOptions> {
    return timeLaunchDiscovery('request', input, () => this.resolveOptions(input));
  }
  private async resolveOptions(input: Input): Promise<SessionLaunchOptions> {
    const defaults = await timeLaunchDiscovery('settings', input, () => this.deps.getSettings());
    const model = resolveSessionModelForProvider(
      input.model,
      input.provider,
      input.provider === 'CLAUDE' ? defaults.defaultClaudeModel : defaults.defaultCodexModel
    );
    if (input.provider === 'CODEX' && this.deps.resolveAccountId) {
      const resolveAccountId = this.deps.resolveAccountId;
      const codexAccountId = await timeLaunchDiscovery('account resolution', input, () =>
        resolveAccountId({ ...input, model })
      );
      input = { ...input, codexAccountId };
    }
    const key = JSON.stringify([
      input.provider,
      model,
      input.provider === 'CODEX' ? (input.codexAccountId ?? 'auto') : null,
    ]);
    const native = await timeLaunchDiscovery('options', { ...input, model }, () =>
      this.getNativeOptions(key, { ...input, model })
    );
    const effort =
      input.provider === 'CLAUDE'
        ? defaults.defaultClaudeReasoningEffort
        : defaults.defaultCodexReasoningEffort;
    if (effort && native.reasoning.options.some((option) => option.value === effort)) {
      native.reasoning.selected = effort;
    }
    return native;
  }
  private async getNativeOptions(key: string, input: Input): Promise<SessionLaunchOptions> {
    for (const [entry, cached] of this.cache) {
      if (Date.now() - cached.capturedAt >= CACHE_MAX_AGE_MS) {
        this.cache.delete(entry);
      }
    }
    const cached = this.cache.get(key);
    if (cached) {
      const ageMs = Date.now() - cached.capturedAt;
      if (
        ageMs >= CACHE_FRESH_MS &&
        Date.now() >= cached.refreshAfter &&
        !this.pending.has(key) &&
        this.pending.size < MAX_PENDING_DISCOVERIES
      ) {
        cached.refreshAfter = Date.now() + REFRESH_RETRY_MS;
        void this.discover(key, input).result.catch((error: unknown) => {
          cached.refreshAfter = Date.now() + REFRESH_RETRY_MS;
          logger.warn('Launch options background refresh failed; keeping cached options', {
            ...input,
            error,
          });
        });
      }
      logger.debug('Launch options cache hit', { ...input, ageMs, stale: ageMs >= CACHE_FRESH_MS });
      return structuredClone(cached.value);
    }
    let pending = this.pending.get(key);
    if (pending?.succeeded) {
      // The cached success expired/was evicted while its native lifetime stayed charged.
      throw new Error('Launch discovery is busy; retry shortly');
    }
    if (!pending) {
      if (this.pending.size >= MAX_PENDING_DISCOVERIES) {
        throw new Error('Launch discovery is busy; retry shortly');
      }
      pending = this.discover(key, input);
    }
    return structuredClone(await pending.result);
  }
  private discover(key: string, input: Input): PendingDiscovery {
    const started = Promise.resolve().then(() => this.deps.fetchOptions(input));
    const entry: PendingDiscovery = {
      succeeded: false,
      drained: started.then(
        async (discovery) => {
          await Promise.all([
            discovery.result.then(
              () => undefined,
              () => undefined
            ),
            discovery.drained,
          ]);
        },
        () => undefined
      ),
      result: started
        .then((discovery) => discovery.result)
        .then((value) => {
          this.cache.delete(key);
          if (this.cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
              this.cache.delete(oldest);
            }
          }
          this.cache.set(key, {
            value: structuredClone(value),
            capturedAt: Date.now(),
            refreshAfter: 0,
          });
          entry.succeeded = true;
          return value;
        }),
    };
    this.pending.set(key, entry);
    void entry.drained.then(
      () => {
        if (this.pending.get(key) === entry) {
          this.pending.delete(key);
        }
      },
      (error: unknown) => {
        logger.warn('Launch discovery drain failed; retaining admission', { error });
      }
    );
    return entry;
  }
}
