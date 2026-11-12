import { WORKSPACE_METADATA_INSTRUCTIONS } from '@/backend/prompts/workspace-metadata';
import { configService } from '@/backend/services/config.service';
import { runDisposableInference } from '@/backend/services/session/service/inference/disposable-inference';
import { WorkspaceMetadataResultSchema } from '@/shared/workspace-conversation-summary';

export interface WorkspaceMetadataGenerationInput {
  provider: 'CODEX' | 'CLAUDE';
  codexAccountId?: string | null;
  input: unknown;
}

/** Disposable metadata inference: no working-session mutation, tools, or repository context. */
export function generateWorkspaceMetadata(
  input: WorkspaceMetadataGenerationInput,
  signal: AbortSignal
) {
  const settings = configService.getWorkspaceMetadataConfig();
  return runDisposableInference(
    {
      label: 'Workspace metadata',
      provider: input.provider,
      codexAccountId: input.codexAccountId,
      model: input.provider === 'CLAUDE' ? settings.claudeModel : settings.codexModel,
      instructions: WORKSPACE_METADATA_INSTRUCTIONS,
      prompt: JSON.stringify(input.input),
      schema: WorkspaceMetadataResultSchema,
      timeoutMs: 45_000,
    },
    signal
  );
}
