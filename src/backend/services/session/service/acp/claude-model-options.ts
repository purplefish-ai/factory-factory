import type { SessionConfigSelectOption } from '@agentclientprotocol/sdk';

type ClaudeModelOptionLabelInput = Pick<
  SessionConfigSelectOption,
  'value' | 'name' | 'description'
>;

const CONTEXT_SUFFIX = /\s+with\s+(\d+(?:\.\d+)?[KMG]?)\s+context$/i;

export function formatClaudeModelOptionName(option: ClaudeModelOptionLabelInput): string {
  const identity = option.description?.split('·')[0]?.trim();
  if (!identity) {
    return option.name;
  }

  const conciseIdentity = identity.replace(CONTEXT_SUFFIX, ' ($1)');
  return option.value === 'default' ? `Default — ${conciseIdentity}` : conciseIdentity;
}
