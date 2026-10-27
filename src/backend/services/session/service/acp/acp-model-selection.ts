import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpConnection } from './acp-connection';
import { requireSessionConfigOptions } from './acp-session-config-options';
import { formatClaudeModelOptionName } from './claude-model-options';

function confirmsModelSelection(provider: string, expected: string, observed: unknown): boolean {
  if (observed === expected) {
    return true;
  }
  if (provider !== 'CLAUDE' || typeof observed !== 'string') {
    return false;
  }
  const family = /^(sonnet|opus|haiku|fable)(\[1m\])?$/.exec(expected)?.[1];
  return Boolean(
    family &&
    new RegExp(`^claude-${family}-\\d`).test(observed) &&
    observed.endsWith('[1m]') === expected.endsWith('[1m]')
  );
}

/** Resolve aliases only when the provider advertises an unambiguous model identity. */
export function resolveAcpModelSelection(
  provider: string,
  configOptions: SessionConfigOption[],
  requested: string
): { configId: string; value: string } {
  const option = configOptions.find((entry) => entry.category === 'model' || entry.id === 'model');
  if (option?.type !== 'select') {
    throw new Error(`Model selection is unavailable for ${provider}`);
  }
  const choices = option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  const exact = choices.find((entry) => entry.value === requested);
  if (exact) {
    return { configId: option.id, value: exact.value };
  }
  if (option.currentValue === requested) {
    return { configId: option.id, value: requested };
  }
  // Codex's saved "default" means the runtime's current native default.
  if (provider === 'CODEX' && requested === 'default') {
    return { configId: option.id, value: option.currentValue };
  }
  if (provider === 'CLAUDE' && /^(sonnet|opus|haiku|fable)(\[1m\])?$/.test(requested)) {
    const [family] = requested.split('[');
    const matches = choices.filter(
      (entry) =>
        entry.value.startsWith(`claude-${family}-`) &&
        entry.value.endsWith('[1m]') === requested.endsWith('[1m]')
    );
    if (matches.length === 1 && matches[0]) {
      return { configId: option.id, value: matches[0].value };
    }
  }
  const canonical =
    provider === 'CLAUDE'
      ? /^claude-(sonnet|opus|haiku|fable)-(\d+(?:-\d+)*)(\[1m\])?$/.exec(requested)
      : null;
  if (canonical) {
    const [, family, version, context = ''] = canonical;
    const alias = choices.find(
      (entry) =>
        entry.value === `${family}${context}` &&
        formatClaudeModelOptionName(entry)
          .toLowerCase()
          .replace(/\s+\([^)]*\)$/, '') === `${family} ${version?.replaceAll('-', '.')}`
    );
    if (alias) {
      return { configId: option.id, value: alias.value };
    }
  }
  throw new Error(`Unsupported model "${requested}" for ${provider}`);
}

export async function applyAcpStartupModel(params: {
  connection: AcpConnection;
  provider: string;
  providerSessionId: string;
  configOptions: SessionConfigOption[];
  model?: string;
}): Promise<SessionConfigOption[]> {
  if (!params.model) {
    return params.configOptions;
  }
  const target = resolveAcpModelSelection(params.provider, params.configOptions, params.model);
  if (
    params.configOptions.find((option) => option.id === target.configId)?.currentValue ===
    target.value
  ) {
    return params.configOptions;
  }
  const result = await params.connection.setSessionConfigOption({
    sessionId: params.providerSessionId,
    configId: target.configId,
    value: target.value,
  });
  const confirmed = requireSessionConfigOptions(params.provider, 'setSessionConfigOption', result);
  const observed = confirmed.find((option) => option.id === target.configId)?.currentValue;
  if (
    observed !== params.model &&
    !(params.model.startsWith('claude-')
      ? observed === target.value
      : confirmsModelSelection(params.provider, target.value, observed))
  ) {
    throw new Error(`Configured model "${params.model}" was not applied by ${params.provider}`);
  }
  return confirmed;
}
