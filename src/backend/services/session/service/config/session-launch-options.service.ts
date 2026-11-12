import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { createLogger } from '@/backend/services/logger.service';
import { withTimeout } from '@/backend/services/session/service/acp/acp-runtime-spawn';
import { timeLaunchDiscovery } from '@/backend/services/session/service/acp/launch-discovery-timing';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import type { LaunchOptionsPersistence, StoredLaunchOptions } from './session-launch-options-store';
type Input = { provider: 'CLAUDE' | 'CODEX'; model?: string; codexAccountId?: string };
type Defaults = {
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
};
const CACHE_FRESH_MS = 5 * 60_000;
const REFRESH_RETRY_MS = 30_000;
// Room for every advertised model of both providers across a few Codex accounts.
const MAX_CACHE_ENTRIES = 128;
const MAX_PENDING_DISCOVERIES = 8;
const logger = createLogger('session-launch-options');
type Discovery = {
  result: Promise<SessionLaunchOptions>;
  /** Other models captured by the same disposable session; never rejects. */
  additional?: Promise<SessionLaunchOptions[]>;
  drained: Promise<void>;
};
type SelectModels = (models: readonly string[]) => readonly string[];
type PendingDiscovery = Discovery & { succeeded: boolean };
type CachedOptions = StoredLaunchOptions & { refreshAfter: number };
export class SessionLaunchOptionsService {
  private readonly cache = new Map<string, CachedOptions>();
  private readonly pending = new Map<string, PendingDiscovery>();
  private restored: Promise<void> | undefined;
  private readonly cancellation = new AbortController();
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private readonly deps: {
      fetchOptions(
        input: Input,
        signal?: AbortSignal,
        selectAdditionalModels?: SelectModels
      ): Promise<Discovery>;
      getSettings(): Promise<Defaults>;
      resolveAccountId?(input: Input): Promise<string>;
      store?: LaunchOptionsPersistence;
    }
  ) {}
  getOptions(input: Input): Promise<SessionLaunchOptions> {
    return timeLaunchDiscovery('request', input, () => this.resolveOptions(input));
  }
  async stop(): Promise<void> {
    this.cancellation.abort(new Error('Launch discovery stopped'));
    await withTimeout({
      promise: Promise.all([...this.pending.values()].map((entry) => entry.drained)).then(
        () => this.writing
      ),
      timeoutMs: 7000,
      description: 'launch discovery shutdown',
    });
  }
  private assertRunning(): void {
    this.cancellation.signal.throwIfAborted();
  }
  async warm(): Promise<void> {
    await this.restore();
    await Promise.allSettled(
      (['CLAUDE', 'CODEX'] as const).map((provider) => this.getOptions({ provider }))
    );
  }
  private restore(): Promise<void> {
    this.restored ??= Promise.resolve().then(async () => {
      try {
        for (const entry of (await this.deps.store?.load()) ?? []) {
          this.cacheOptions(this.key(entry.input), {
            ...entry,
            // Every restart refreshes restored metadata, including after runtime upgrades.
            capturedAt: Math.min(entry.capturedAt, Date.now() - CACHE_FRESH_MS),
            refreshAfter: 0,
          });
        }
      } catch {
        logger.warn('Launch options cache restore failed');
      }
    });
    return this.restored;
  }
  private key(input: Input): string {
    return JSON.stringify([
      input.provider,
      input.model,
      input.provider === 'CODEX' ? (input.codexAccountId ?? 'auto') : null,
    ]);
  }
  private persist(): void {
    if (!this.deps.store) {
      return;
    }
    const entries = Array.from(this.cache.values(), ({ input, value, capturedAt }) => ({
      input,
      value,
      capturedAt,
    }));
    this.writing = this.writing
      .then(() => this.deps.store?.save(entries))
      .catch(() => {
        logger.warn('Launch options cache save failed');
      });
  }
  private async resolveOptions(input: Input): Promise<SessionLaunchOptions> {
    this.assertRunning();
    await this.restore();
    this.assertRunning();
    const defaults = await timeLaunchDiscovery('settings', input, () => this.deps.getSettings());
    this.assertRunning();
    const model = resolveSessionModelForProvider(
      input.model,
      input.provider,
      input.provider === 'CLAUDE' ? defaults.defaultClaudeModel : defaults.defaultCodexModel
    );
    const key = this.key({ ...input, model });
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
        void this.discover(key, input).result.catch(() => {
          cached.refreshAfter = Date.now() + REFRESH_RETRY_MS;
          if (!this.cache.has(key)) {
            this.cacheOptions(key, cached);
          }
          logger.warn('Launch options background refresh failed', { ...input });
        });
      }
      logger.debug('Launch options cache hit', { ...input, ageMs, stale: ageMs >= CACHE_FRESH_MS });
      return structuredClone(cached.value);
    }
    let pending = this.pending.get(key);
    if (pending?.succeeded) {
      // The cached success was evicted while its native lifetime stayed charged.
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
  private cacheOptions(key: string, cached: CachedOptions): void {
    this.cache.delete(key);
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, cached);
  }
  /**
   * Swept models fill only missing entries: a direct discovery of a model also
   * knows its thinking default, which a sweep cannot observe. They start stale
   * so their first use returns them at once and refreshes in the background.
   */
  private async cacheAdditional(
    input: Input,
    additional: Promise<SessionLaunchOptions[]>
  ): Promise<void> {
    const captured = await additional;
    if (this.cancellation.signal.aborted) {
      return;
    }
    const capturedAt = Date.now() - CACHE_FRESH_MS;
    let added = false;
    for (const value of captured) {
      const modelInput = { ...input, model: value.model };
      const modelKey = this.key(modelInput);
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        break;
      }
      if (this.cache.has(modelKey)) {
        continue;
      }
      this.cacheOptions(modelKey, {
        input: modelInput,
        value: structuredClone(value),
        capturedAt,
        refreshAfter: 0,
      });
      added = true;
    }
    if (added) {
      this.persist();
    }
  }
  private discover(key: string, input: Input): PendingDiscovery {
    // Capture every advertised model nobody has discovered yet, so switching
    // models in the launcher reads the cache instead of starting a probe.
    // Swept entries only use free capacity; they never evict other results.
    const selectAdditionalModels: SelectModels = (models) =>
      models
        .filter((model) => {
          const modelKey = this.key({ ...input, model });
          return !(this.cache.has(modelKey) || this.pending.has(modelKey));
        })
        // Leave room for the requested model's own entry.
        .slice(0, Math.max(0, MAX_CACHE_ENTRIES - this.cache.size - (this.cache.has(key) ? 0 : 1)));
    const started = Promise.resolve().then(async () => {
      this.assertRunning();
      if (input.provider === 'CODEX' && this.deps.resolveAccountId) {
        const codexAccountId = await this.deps.resolveAccountId(input);
        this.assertRunning();
        return this.deps.fetchOptions(
          { ...input, codexAccountId },
          this.cancellation.signal,
          selectAdditionalModels
        );
      }
      return this.deps.fetchOptions(input, this.cancellation.signal, selectAdditionalModels);
    });
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
      result: started.then(async (discovery) => {
        const value = await discovery.result;
        this.assertRunning();
        this.cacheOptions(key, {
          input,
          value: structuredClone(value),
          capturedAt: Date.now(),
          refreshAfter: 0,
        });
        this.persist();
        entry.succeeded = true;
        if (discovery.additional) {
          void this.cacheAdditional(input, discovery.additional);
        }
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
