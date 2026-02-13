/**
 * Information about a slash command from the Claude CLI.
 */
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * Information about an available model.
 */
export interface ModelInfo {
  value: string;
  displayName: string;
}

/**
 * Available models using Claude CLI aliases.
 * Opus is the default (when selectedModel is null).
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
];

/**
 * Chat session settings that persist per-session.
 */
export interface ChatSettings {
  selectedModel: string;
  reasoningEffort: string | null;
  thinkingEnabled: boolean;
  planModeEnabled: boolean;
}

/**
 * Default chat settings for new sessions.
 */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  selectedModel: 'opus',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};

/**
 * Resolve nullable/optional model selection to the canonical default.
 */
export function resolveSelectedModel(selectedModel: string | null | undefined): string {
  return selectedModel ?? DEFAULT_CHAT_SETTINGS.selectedModel;
}

/**
 * Default thinking budget (tokens) for extended thinking mode.
 * Used with the SDK's set_max_thinking_tokens control request.
 */
export const DEFAULT_THINKING_BUDGET = 10_000;

/**
 * @deprecated Use DEFAULT_THINKING_BUDGET with setMaxThinkingTokens instead.
 * Suffix previously appended to user messages to enable extended thinking mode.
 * Kept for backwards compatibility during migration.
 */
export const THINKING_SUFFIX = ' ultrathink';

/**
 * Valid model values for server-side validation.
 */
export const VALID_MODEL_VALUES = AVAILABLE_MODELS.map((m) => m.value);
