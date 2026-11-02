import { z } from 'zod';

export function getClosedSessionConversationEpoch(metadata: unknown): number {
  const parsed = z
    .object({ providerIdentityRollovers: z.array(z.unknown()).optional() })
    .safeParse(metadata);
  return parsed.success ? (parsed.data.providerIdentityRollovers?.length ?? 0) : 0;
}
