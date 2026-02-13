export type HydrateKeyInput = {
  claudeSessionId: string | null;
  claudeProjectPath: string | null;
};

export function buildHydrateKey(options: HydrateKeyInput): string {
  return `${options.claudeSessionId ?? 'none'}::${options.claudeProjectPath ?? 'none'}`;
}
