import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import { getConfigOptionValues } from './session-config-option-helpers';

type NativeModeKind = 'mode' | 'collaboration_mode';
type Runtime = Pick<AcpRuntimeManager, 'setConfigOption' | 'setSessionMode' | 'getClient'>;

function isNativeMode(option: SessionConfigOption, kind: NativeModeKind): boolean {
  return option.id === kind || option.category === kind;
}

function nativeModes(options: SessionConfigOption[], provider: string): SessionConfigOption[] {
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error('Native session configuration contains duplicate option IDs');
  }
  const access = options.filter((option) => isNativeMode(option, 'mode'));
  const planning =
    provider === 'CODEX'
      ? options.filter((option) => isNativeMode(option, 'collaboration_mode'))
      : [];
  if (
    access.length !== 1 ||
    planning.length > 1 ||
    planning.some((option) => option.id === access[0]?.id)
  ) {
    throw new Error('Native session access or planning mode is missing or ambiguous');
  }
  return [...access, ...planning];
}

function savedModes(
  session: AgentSessionRecord,
  handle: AcpProcessHandle
): SessionConfigOption[] | null {
  const metadata = session.providerMetadata;
  if (!(metadata && typeof metadata === 'object' && Object.hasOwn(metadata, 'acpConfigSnapshot'))) {
    return null;
  }
  const snapshot = parseAcpConfigSnapshot(metadata);
  const identity =
    handle.sessionCreationOutcome?.kind === 'resume_fallback'
      ? handle.sessionCreationOutcome.previousProviderSessionId
      : handle.providerSessionId;
  if (
    !snapshot ||
    snapshot.provider !== session.provider ||
    handle.provider !== session.provider ||
    !session.providerSessionId ||
    snapshot.providerSessionId !== session.providerSessionId ||
    identity !== session.providerSessionId
  ) {
    throw new Error(
      'Saved native session configuration is invalid or belongs to another conversation'
    );
  }
  const activeModes = nativeModes(handle.configOptions, handle.provider);
  return nativeModes(snapshot.configOptions, handle.provider).map((saved) => {
    const kind = isNativeMode(saved, 'mode') ? 'mode' : 'collaboration_mode';
    const active = activeModes.find(
      (option) => option.id === saved.id && isNativeMode(option, kind)
    );
    if (
      saved.type !== 'select' ||
      active?.type !== 'select' ||
      !getConfigOptionValues(saved).includes(saved.currentValue) ||
      !getConfigOptionValues(active).includes(saved.currentValue)
    ) {
      throw new Error(`Saved native session mode is unavailable: ${saved.id}`);
    }
    return saved;
  });
}

function assertCurrentRuntime(sessionId: string, handle: AcpProcessHandle, runtime: Runtime): void {
  if (runtime.getClient(sessionId) !== handle) {
    throw new Error('Session runtime changed while restoring native modes');
  }
}

/** Restore explicit native choices before adapter defaults can replace their snapshot. */
export async function restoreSavedNativeModes(
  sessionId: string,
  session: AgentSessionRecord,
  handle: AcpProcessHandle,
  runtime: Runtime
): Promise<boolean | undefined> {
  const targets = savedModes(session, handle);
  if (!targets) {
    return undefined;
  }
  let changed = false;
  for (const saved of targets) {
    assertCurrentRuntime(sessionId, handle, runtime);
    if (
      handle.configOptions.find((option) => option.id === saved.id)?.currentValue ===
      saved.currentValue
    ) {
      continue;
    }
    handle.configOptions = isNativeMode(saved, 'mode')
      ? await runtime.setSessionMode(sessionId, String(saved.currentValue))
      : await runtime.setConfigOption(sessionId, saved.id, String(saved.currentValue));
    changed = true;
  }
  assertCurrentRuntime(sessionId, handle, runtime);
  for (const saved of targets) {
    if (
      handle.configOptions.find((option) => option.id === saved.id)?.currentValue !==
      saved.currentValue
    ) {
      throw new Error(`Saved native session mode was not applied: ${saved.id}`);
    }
  }
  return changed;
}
