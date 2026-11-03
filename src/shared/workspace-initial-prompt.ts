import { z } from 'zod';

const initialPromptMetadataSchema = z.object({ initialPrompt: z.string() });

/**
 * The initial prompt saved in a workspace's `creationMetadata`. Workspace
 * detail exposes only this field instead of the metadata, which also retains
 * base64 initial attachments; the server read and the client's optimistic
 * create seed both project it here so their shapes stay in step.
 */
export function readWorkspaceInitialPrompt(creationMetadata: unknown): string | null {
  const parsed = initialPromptMetadataSchema.safeParse(creationMetadata);
  return parsed.success ? parsed.data.initialPrompt : null;
}
