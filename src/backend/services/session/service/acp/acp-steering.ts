import type { ContentBlock } from '@agentclientprotocol/sdk/unstable';
import { z } from 'zod';
import type { AcpProcessHandle } from './acp-process-handle';

const steeringCapabilitySchema = z.object({
  steering: z.object({ supported: z.literal(true) }),
});
const steeringResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('injected') }),
  z.object({ outcome: z.literal('promptRequired'), reason: z.literal('noRunningTurn') }),
]);

export function supportsAcpSteering(initializeMeta: unknown): boolean {
  return steeringCapabilitySchema.safeParse(initializeMeta).success;
}

export async function steerAcpPrompt(
  handle: AcpProcessHandle,
  prompt: ContentBlock[]
): Promise<{ outcome: 'injected' | 'promptRequired' }> {
  if (!handle.supportsSteering) {
    throw new Error('The agent adapter does not support steering. The message remains queued.');
  }
  const response = await handle.connection.extMethod('_session/steering', {
    sessionId: handle.acpSessionId,
    prompt,
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  });
  const parsed = steeringResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error('The agent adapter returned an invalid steering response.');
  }
  return { outcome: parsed.data.outcome };
}
