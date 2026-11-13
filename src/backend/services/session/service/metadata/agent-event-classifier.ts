import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import {
  AGENT_EVENT_CLASSIFICATION_INSTRUCTIONS,
  AGENT_EVENT_CLASSIFICATION_PROMPT_VERSION,
  agentEventClassificationResultSchema,
  buildAgentEventClassificationPrompt,
} from '@/backend/prompts/agent-event-classification';
import { configService } from '@/backend/services/config.service';
import {
  DisposableInferenceError,
  runDisposableInference,
} from '@/backend/services/session/service/inference/disposable-inference';
import type { AgentEventPayload } from '@/shared/agent-runtime';
import type { SessionProvider } from '@/shared/core/enums';

export interface AgentEventClassificationInput {
  provider: SessionProvider;
  /** Codex account for the call; null uses the default account. Ignored for Claude. */
  accountId: string | null;
  filterInstructions: string;
  /** Untrusted event content; the prompt projects only its subject fields. */
  eventContext: AgentEventPayload;
}

export interface AgentEventClassifierIdentity {
  provider: SessionProvider;
  model: string;
  promptVersion: string;
  inputHash: string;
}

export type AgentEventClassificationFailure = 'TIMEOUT' | 'RATE_LIMITED' | 'MALFORMED' | 'FAILED';

/** Non-dispatching classifier failure; carries no provider output. */
export class AgentEventClassificationError extends Error {
  constructor(
    readonly code: AgentEventClassificationFailure,
    readonly classifier: AgentEventClassifierIdentity,
    readonly retryAfterMs?: number
  ) {
    super(`Event classification failed: ${code}`);
    this.name = 'AgentEventClassificationError';
  }
}

let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (active < limit) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      waiting.splice(waiting.indexOf(grant), 1);
      reject(signal.reason);
    };
    waiting.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    // The slot passes directly to the next waiter.
    next();
  } else {
    active--;
  }
}

function failureOf(error: unknown): {
  code: AgentEventClassificationFailure;
  retryAfterMs?: number;
} {
  if (error instanceof DisposableInferenceError) {
    return { code: error.kind, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return { code: 'MALFORMED' };
  }
  return { code: 'FAILED' };
}

/**
 * Classifies one deterministically matched event against a trigger's
 * natural-language filter in a disposable, tools-disabled provider call.
 */
export async function classifyAgentEvent(
  input: AgentEventClassificationInput,
  signal: AbortSignal
) {
  const settings = configService.getAgentEventClassifierConfig();
  const model = input.provider === 'CLAUDE' ? settings.claudeModel : settings.codexModel;
  const prompt = buildAgentEventClassificationPrompt(input.filterInstructions, input.eventContext);
  const classifier: AgentEventClassifierIdentity = {
    provider: input.provider,
    model,
    promptVersion: AGENT_EVENT_CLASSIFICATION_PROMPT_VERSION,
    inputHash: createHash('sha256')
      .update(
        JSON.stringify([AGENT_EVENT_CLASSIFICATION_PROMPT_VERSION, input.provider, model, prompt])
      )
      .digest('hex'),
  };
  await acquireSlot(settings.maxConcurrent, signal);
  try {
    const result = await runDisposableInference(
      {
        label: 'Event classification',
        provider: input.provider,
        codexAccountId: input.accountId,
        model,
        instructions: AGENT_EVENT_CLASSIFICATION_INSTRUCTIONS,
        prompt,
        schema: agentEventClassificationResultSchema,
        timeoutMs: settings.timeoutMs,
      },
      signal
    );
    return { ...result, classifier };
  } catch (error) {
    signal.throwIfAborted();
    const failure = failureOf(error);
    throw new AgentEventClassificationError(failure.code, classifier, failure.retryAfterMs);
  } finally {
    releaseSlot();
  }
}
