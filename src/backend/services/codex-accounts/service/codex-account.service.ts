import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID,
  type CodexAccountSummary,
  type CodexLoginState,
} from '@/shared/codex-accounts';
import type { ProviderPlanUsage } from '@/shared/provider-usage';
import {
  accountPressure,
  chooseAccount,
  supportsReasoningEffort,
  type AccountCandidate,
} from './account-selection';
import { matchesNativeEmailFallback } from './identity';
import { LoginCoordinator } from './login-coordinator';
import { prepareAccountContext, resolveAccountContext, resolveHistoryContext } from './profile';
import { hasVerifiedScope } from './types';
import type {
  AccountConfig,
  AccountIdentity,
  AccountObservation,
  AccountRow,
  AccountSelectionOptions,
  AccountStore,
  CodexRuntimeContext,
  NativeLogin,
} from './types';

const labelSchema = z.string().trim().min(1).max(100);
const updateSchema = z.object({ label: labelSchema.optional(), enabled: z.boolean().optional() });
const unknownUsage = (): ProviderPlanUsage => ({
  provider: 'CODEX',
  status: 'unavailable',
  windows: [],
  updatedAt: new Date().toISOString(),
});
export class CodexAccountService {
  private cache = new Map<string, { expires: number; observation: AccountObservation }>();
  private pending = new Map<string, Promise<AccountObservation>>();
  private revision = 0;
  private reservations = new Map<string, number>();
  private recency = new Map<string, number>();
  private sequence = 0;
  private allocation: Promise<unknown> = Promise.resolve();
  private readonly logins: LoginCoordinator;
  private identityCache = new Map<string, { expires: number; identity: AccountIdentity }>();
  private identityPending = new Map<string, Promise<AccountIdentity>>();
  constructor(
    private readonly dependencies: {
      store: AccountStore;
      config: AccountConfig;
      probe(context: CodexRuntimeContext, signal?: AbortSignal): Promise<AccountObservation>;
      login: NativeLogin;
      probeIdentity?(context: CodexRuntimeContext, signal?: AbortSignal): Promise<AccountIdentity>;
    }
  ) {
    this.logins = new LoginCoordinator({
      resolve: async (id, signal) => {
        const row = await this.row(id);
        signal.throwIfAborted();
        return { row, context: await resolveAccountContext(row, this.dependencies.config) };
      },
      prepare: async (_id, signal) => {
        const row = await this.row();
        await this.readIdentity(row, true, signal);
      },
      probe: (context, signal) =>
        this.dependencies.probeIdentity?.(context, signal) ??
        this.dependencies.probe(context, signal),
      verify: async (id, identity, persist) =>
        this.verifyIdentity(await this.row(id), identity, persist, true),
      login: dependencies.login,
      invalidate: () => this.invalidate(),
    });
  }
  invalidate(): void {
    this.revision++;
    this.cache.clear();
    this.pending.clear();
    this.identityCache.clear();
    this.identityPending.clear();
  }
  private getReservationCount(id: string): number {
    return this.reservations.get(id) ?? 0;
  }
  private async row(id = NATIVE_DEFAULT_CODEX_ACCOUNT_ID): Promise<AccountRow> {
    await this.dependencies.store.list();
    const row = await this.dependencies.store.get(id);
    if (!row) {
      throw new Error('Codex account no longer exists');
    }
    return row;
  }
  private readIdentity(
    row: AccountRow,
    refresh = false,
    signal?: AbortSignal
  ): Promise<AccountIdentity> {
    if (signal) {
      return resolveAccountContext(row, this.dependencies.config)
        .then((context) => {
          signal.throwIfAborted();
          return (
            this.dependencies.probeIdentity?.(context, signal) ??
            this.dependencies.probe(context, signal)
          );
        })
        .then((identity) => {
          signal.throwIfAborted();
          this.identityCache.set(row.id, { expires: Date.now() + 30_000, identity });
          return identity;
        });
    }
    const cached = this.identityCache.get(row.id);
    if (!refresh && cached && cached.expires > Date.now()) {
      return Promise.resolve(cached.identity);
    }
    const pending = this.identityPending.get(row.id);
    if (pending !== undefined) {
      return pending;
    }
    const revision = this.revision;
    const reading = resolveAccountContext(row, this.dependencies.config)
      .then(
        (context) => this.dependencies.probeIdentity?.(context) ?? this.dependencies.probe(context)
      )
      .then((identity) => {
        if (revision !== this.revision) {
          throw new Error('Codex account changed during identity observation');
        }
        this.identityCache.set(row.id, { expires: Date.now() + 30_000, identity });
        return identity;
      })
      .finally(() => {
        if (this.identityPending.get(row.id) === reading) {
          this.identityPending.delete(row.id);
        }
      });
    this.identityPending.set(row.id, reading);
    return reading;
  }
  private observe(row: AccountRow, refresh = false): Promise<AccountObservation> {
    const cached = this.cache.get(row.id);
    if (!refresh && cached && cached.expires > Date.now()) {
      return Promise.resolve(cached.observation);
    }
    const existing = this.pending.get(row.id);
    if (existing) {
      return existing;
    }
    const revision = this.revision;
    const reading = resolveAccountContext(row, this.dependencies.config)
      .then((context) => this.dependencies.probe(context))
      .then(async (observation) => {
        if (revision !== this.revision) {
          throw new Error('Codex account changed during observation');
        }
        await this.verifyIdentity(row, observation);
        this.cache.set(row.id, { expires: Date.now() + 30_000, observation });
        this.identityCache.set(row.id, { expires: Date.now() + 30_000, identity: observation });
        return observation;
      })
      .finally(() => {
        if (this.pending.get(row.id) === reading) {
          this.pending.delete(row.id);
        }
      });
    this.pending.set(row.id, reading);
    return reading;
  }
  private async verifyIdentity(
    row: AccountRow,
    observation: AccountIdentity,
    persist = true,
    staged = false
  ): Promise<void> {
    if (row.kind === 'MANAGED' && observation.authenticated && !hasVerifiedScope(observation)) {
      throw new Error('Codex managed account identity could not be verified');
    }
    const upgrading =
      staged &&
      row.kind === 'MANAGED' &&
      hasVerifiedScope(observation) &&
      matchesNativeEmailFallback(row.identityKey, observation.email);
    if (row.identityKey && observation.identityKey !== row.identityKey && !upgrading) {
      throw this.identityChangedError(row);
    }
    if (staged && row.kind === 'MANAGED') {
      this.verifyNativeScope(observation);
    }
    if (observation.identityKey) {
      const duplicate = (await this.dependencies.store.list()).find(
        (other) => other.id !== row.id && other.identityKey === observation.identityKey
      );
      if (duplicate) {
        throw new Error('This Codex account is already connected');
      }
      if ((!row.identityKey || upgrading) && persist) {
        await this.dependencies.store.update(row.id, { identityKey: observation.identityKey });
      }
    }
  }
  private identityChangedError(row: AccountRow): Error {
    return new Error(
      row.kind === 'NATIVE_DEFAULT'
        ? 'Codex native account identity changed; run ff codex login and sign in to the original account to restore existing conversations'
        : 'Codex account identity changed; sign in to the original account'
    );
  }
  private verifyNativeScope(observation: AccountIdentity): void {
    if (observation.email) {
      const nativeIdentity = this.identityCache.get(NATIVE_DEFAULT_CODEX_ACCOUNT_ID)?.identity;
      const sameEmail =
        nativeIdentity?.email?.trim().toLowerCase() === observation.email.trim().toLowerCase();
      if (
        nativeIdentity?.authenticated &&
        (nativeIdentity.identityKey === observation.identityKey ||
          (!hasVerifiedScope(nativeIdentity) && sameEmail))
      ) {
        throw new Error(
          'Native default account scope overlaps or is unverified; this profile cannot be counted as a separate Codex quota'
        );
      }
    }
  }
  async getEnabledAccountIds(): Promise<string[]> {
    return (await this.dependencies.store.list()).filter((row) => row.enabled).map((row) => row.id);
  }
  async getAccounts(): Promise<CodexAccountSummary[]> {
    const rows = await this.dependencies.store.list();
    return Promise.all(
      rows.map(async (row) => {
        let observation: AccountObservation;
        try {
          observation = await this.observe(row);
        } catch {
          observation = {
            authenticated: false,
            scopeVerified: false,
            identityKey: null,
            email: null,
            planType: null,
            models: [],
            usage: {
              ...unknownUsage(),
              status: 'error',
              message: 'Account unavailable; check sign-in and profile identity',
            },
          };
        }
        return {
          id: row.id,
          label: row.label,
          kind: row.kind,
          enabled: row.enabled,
          authenticated: observation.authenticated,
          email: observation.email,
          planType: observation.planType,
          usage: observation.usage,
        };
      })
    );
  }
  async createAccount(label: string): Promise<CodexAccountSummary> {
    const row = await this.dependencies.store.create(labelSchema.parse(label));
    await prepareAccountContext(row, this.dependencies.config);
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      enabled: row.enabled,
      authenticated: false,
      email: null,
      planType: null,
      usage: unknownUsage(),
    };
  }
  async updateAccount(
    id: string,
    input: { label?: string; enabled?: boolean }
  ): Promise<CodexAccountSummary> {
    await this.row(id);
    await this.dependencies.store.update(id, updateSchema.parse(input));
    const summary = (await this.getAccounts()).find((account) => account.id === id);
    if (!summary) {
      throw new Error('Codex account no longer exists');
    }
    return summary;
  }
  async getUsage(id?: string): Promise<ProviderPlanUsage> {
    return (await this.observe(await this.row(id))).usage;
  }
  async getHistoryContext(id?: string): Promise<CodexRuntimeContext> {
    return resolveHistoryContext(await this.row(id), this.dependencies.config);
  }
  private ensureAdmission(id: string): void {
    if (this.logins.isPending(id)) {
      throw new Error('Codex login is pending; wait for authentication to finish');
    }
  }
  async getRuntimeContext(id?: string): Promise<CodexRuntimeContext> {
    const row = await this.row(id);
    this.ensureAdmission(row.id);
    const identity = await this.readIdentity(row, true);
    this.ensureAdmission(row.id);
    if (!identity.authenticated) {
      throw new Error('Codex account is not signed in');
    }
    await this.verifyIdentity(row, identity);
    this.ensureAdmission(row.id);
    const context = await resolveAccountContext(row, this.dependencies.config);
    this.ensureAdmission(row.id);
    return context;
  }
  private async candidate(
    row: AccountRow,
    model?: string,
    includeExhausted = false,
    reasoningEffort?: string | null
  ): Promise<AccountCandidate | null> {
    if (!row.enabled || this.logins.isPending(row.id)) {
      return null;
    }
    try {
      const observation = await this.observe(row);
      if (!observation.authenticated) {
        return null;
      }
      const pressure = accountPressure(observation, model, reasoningEffort);
      return pressure === null || (!includeExhausted && pressure === 100)
        ? null
        : { id: row.id, pressure };
    } catch {
      return null;
    }
  }
  private async candidates(
    model?: string,
    includeExhausted = false,
    reasoningEffort?: string | null
  ): Promise<AccountCandidate[]> {
    const rows = await this.dependencies.store.list();
    const readings = await Promise.all(
      rows.map((row) => this.candidate(row, model, includeExhausted, reasoningEffort))
    );
    const candidates = readings.filter((candidate) => candidate !== null);
    const native = this.identityCache.get(NATIVE_DEFAULT_CODEX_ACCOUNT_ID)?.identity;
    if (
      native?.email &&
      !hasVerifiedScope(native) &&
      rows.some((row) => {
        const observed = this.identityCache.get(row.id)?.identity;
        return (
          row.id !== NATIVE_DEFAULT_CODEX_ACCOUNT_ID &&
          observed?.authenticated &&
          hasVerifiedScope(observed) &&
          observed.email?.toLowerCase() === native.email?.toLowerCase()
        );
      })
    ) {
      return candidates.filter((candidate) => candidate.id !== NATIVE_DEFAULT_CODEX_ACCOUNT_ID);
    }
    return candidates;
  }
  private choose(candidates: AccountCandidate[]): string {
    return chooseAccount(
      candidates.filter((candidate) => !this.logins.isPending(candidate.id)),
      (id) => this.getReservationCount(id),
      (id) => this.recency.get(id) ?? 0
    );
  }
  async getPreviewRuntimeContext(
    options: AccountSelectionOptions = {}
  ): Promise<CodexRuntimeContext> {
    try {
      const id =
        options.accountId ??
        this.choose(await this.candidates(options.model, true, options.reasoningEffort));
      const row = await this.row(id);
      this.ensureAdmission(id);
      const observation = await this.observe(row);
      if (!observation.authenticated) {
        throw new Error('Codex account is not signed in');
      }
      this.ensureAdmission(id);
      this.verifySelection(observation, options);
      return resolveAccountContext(row, this.dependencies.config);
    } catch (cause) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        cause instanceof Error ? cause.message : 'Codex account unavailable; check sign-in',
        { cause }
      );
    }
  }
  private verifySelection(
    observation: AccountObservation,
    { model, reasoningEffort }: AccountSelectionOptions
  ): void {
    if (model && model !== 'default' && !observation.models.includes(model)) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Selected Codex account does not support the requested model'
      );
    }
    if (!supportsReasoningEffort(observation, model, reasoningEffort)) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Selected Codex account does not support the requested reasoning effort'
      );
    }
  }
  async withAccountReservation<T>(
    options: AccountSelectionOptions,
    callback: (accountId: string) => Promise<T>
  ): Promise<T> {
    // Native observation is outside the allocation critical section. Explicit B
    // must remain usable while an unrelated Auto request waits on slow A.
    let candidates: AccountCandidate[] | undefined;
    try {
      if (options.accountId) {
        await this.getRuntimeContext(options.accountId);
        if (options.model || options.reasoningEffort) {
          this.verifySelection(await this.observe(await this.row(options.accountId)), options);
        }
      } else {
        candidates = await this.candidates(options.model, false, options.reasoningEffort);
      }
    } catch (cause) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        cause instanceof Error ? cause.message : 'Codex account unavailable; check sign-in',
        { cause }
      );
    }
    const allocation = this.allocation.then(() => {
      let id: string;
      try {
        id = options.accountId ?? this.choose(candidates ?? []);
        this.ensureAdmission(id);
      } catch (cause) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          cause instanceof Error ? cause.message : 'Codex account unavailable; check sign-in',
          { cause }
        );
      }
      this.reservations.set(id, this.getReservationCount(id) + 1);
      this.recency.set(id, ++this.sequence);
      return id;
    });
    this.allocation = allocation.catch(() => undefined);
    const id = await allocation;
    try {
      return await callback(id);
    } finally {
      const count = this.getReservationCount(id) - 1;
      if (count > 0) {
        this.reservations.set(id, count);
      } else {
        this.reservations.delete(id);
      }
    }
  }
  startLogin(id: string): Promise<CodexLoginState> {
    return this.logins.start(id);
  }
  getLoginStatus(id: string): CodexLoginState {
    return this.logins.status(id);
  }
  cancelLogin(id: string): Promise<CodexLoginState> {
    return this.logins.cancel(id);
  }
  async shutdown(): Promise<void> {
    await this.logins.shutdown();
    this.reservations.clear();
  }
}
