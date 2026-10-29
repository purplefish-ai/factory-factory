import type { CodexAccountSummary } from '@/shared/codex-accounts';
import type { ProviderPlanUsage } from '@/shared/provider-usage';
export interface CodexRuntimeContext {
  accountId: string;
  homeDir: string;
  sessionsDir: string;
  env: NodeJS.ProcessEnv;
}
export interface AccountRow {
  id: string;
  label: string;
  kind: CodexAccountSummary['kind'];
  enabled: boolean;
  identityKey: string | null;
}
export interface AccountStore {
  list(): Promise<AccountRow[]>;
  get(id: string): Promise<AccountRow | null>;
  create(label: string): Promise<AccountRow>;
  update(
    id: string,
    data: { label?: string; enabled?: boolean; identityKey?: string }
  ): Promise<AccountRow>;
}
export interface NativeModel {
  id: string;
  model: string;
  isDefault: boolean;
}
export type AccountIdentity = Pick<
  AccountObservation,
  'authenticated' | 'identityKey' | 'email' | 'planType' | 'scopeVerified'
>;
export interface AccountObservation {
  authenticated: boolean;
  identityKey: string | null;
  scopeVerified: boolean;
  email: string | null;
  planType: string | null;
  models: string[];
  modelCatalog?: NativeModel[];
  usageModelScopes?: Record<string, string | null>;
  usage: ProviderPlanUsage;
}
export interface AccountConfig {
  getBaseDir(): string;
  getCodexHome(): string;
  getCodexSessionsDir(): string;
  getChildProcessEnv(): NodeJS.ProcessEnv;
}
export type NativeLogin = (
  context: CodexRuntimeContext,
  signal: AbortSignal,
  onUrl: (url: string) => void
) => Promise<void>;

export function hasVerifiedScope(identity: AccountIdentity): boolean {
  return identity.scopeVerified && identity.identityKey !== null;
}
