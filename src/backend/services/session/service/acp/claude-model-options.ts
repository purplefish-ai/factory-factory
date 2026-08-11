import type { SessionConfigSelectOption } from '@agentclientprotocol/sdk';

type ClaudeModelOptionLabelInput = Pick<
  SessionConfigSelectOption,
  'value' | 'name' | 'description'
>;

const CONTEXT_SUFFIX = /\s+with\s+(\d+(?:\.\d+)?[KMG]?)\s+context$/i;
const MODEL_VERSION_TOKEN = /\bv?\d+(?:[.-]\d+)*\b/i;
const GENERIC_MODEL_TOKENS = new Set(['claude', 'default', 'model', 'recommended']);

function modelNameTokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter(
    (token) => token.length > 1 && !GENERIC_MODEL_TOKENS.has(token)
  );
}

function isPlausibleModelIdentity(identity: string, option: ClaudeModelOptionLabelInput): boolean {
  if (!MODEL_VERSION_TOKEN.test(identity)) {
    return false;
  }
  if (option.value === 'default') {
    return true;
  }

  const identityTokens = new Set(modelNameTokens(identity));
  return modelNameTokens(`${option.name} ${option.value}`).some((token) =>
    identityTokens.has(token)
  );
}

export function formatClaudeModelOptionName(option: ClaudeModelOptionLabelInput): string {
  const identity = option.description?.split('·')[0]?.trim();
  if (!(identity && isPlausibleModelIdentity(identity, option))) {
    return option.name;
  }

  const conciseIdentity = identity.replace(CONTEXT_SUFFIX, ' ($1)');
  return option.value === 'default' ? `Default — ${conciseIdentity}` : conciseIdentity;
}
