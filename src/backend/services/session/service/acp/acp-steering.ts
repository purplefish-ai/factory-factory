import type { ContentBlock } from '@agentclientprotocol/sdk/unstable';
import { z } from 'zod';
import type { AcpProcessHandle } from './acp-process-handle';
import { withTimeout } from './acp-runtime-spawn';

const STEERING_TIMEOUT_MS = 10_000;

/** The adapter did not receive input, so an exact armed wake may safely fall back. */
export class AcpSteeringNotSentError extends Error {}

export class AcpSteeringTimeoutError extends Error {
  constructor() {
    super('Steering acknowledgment timed out. The unresponsive agent runtime was stopped.');
    this.name = 'AcpSteeringTimeoutError';
  }
}

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
  prompt: ContentBlock[],
  options?: { onLateInjected?: () => Promise<void> }
): Promise<{ outcome: 'injected' | 'promptRequired' }> {
  if (!handle.supportsSteering) {
    throw new AcpSteeringNotSentError(
      'The agent adapter does not support steering. The message remains queued.'
    );
  }
  const operation = handle.connection.extMethod('_session/steering', {
    sessionId: handle.acpSessionId,
    prompt,
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  });
  let response: unknown;
  try {
    response = await withTimeout({
      promise: operation,
      timeoutMs: STEERING_TIMEOUT_MS,
      description: 'steering request',
      timeoutError: new AcpSteeringTimeoutError(),
    });
  } catch (error) {
    if (error instanceof AcpSteeringTimeoutError && options?.onLateInjected) {
      void operation
        .then(async (late) => {
          const parsed = steeringResponseSchema.safeParse(late);
          if (parsed.success && parsed.data.outcome === 'injected') {
            await options.onLateInjected?.();
          }
        })
        .catch(() => undefined);
    }
    throw error;
  }
  const parsed = steeringResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error('The agent adapter returned an invalid steering response.');
  }
  return { outcome: parsed.data.outcome };
}
