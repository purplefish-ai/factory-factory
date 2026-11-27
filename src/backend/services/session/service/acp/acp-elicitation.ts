import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@/shared/acp-protocol/sdk-types';
import { type AcpElicitationForm, createAcpElicitationForm } from './acp-elicitation-form';

const responseAnswersSchema = z.object({
  factoryFactory: z.object({
    toolUserInputAnswers: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
const urlRequestSchema = z.object({
  url: z.url().refine((url) => /^https?:\/\//i.test(url)),
  elicitationId: z.string(),
});
const asyncDelivery = z.object({ codex: z.object({ delivery: z.literal('async') }) });

type ElicitationPresentation = {
  title: string;
  acceptLabel: string;
  rawInput: Record<string, unknown>;
  form: AcpElicitationForm | null;
};

function createPresentation(params: CreateElicitationRequest): ElicitationPresentation | null {
  if (params.mode === 'form' && 'requestedSchema' in params) {
    const form = createAcpElicitationForm(params.requestedSchema, params.message);
    if (!form) {
      return null;
    }
    if (form.questions.length === 0) {
      return {
        form,
        title: 'Confirm request',
        acceptLabel: 'Confirm',
        rawInput: { type: 'FormElicitation', message: params.message },
      };
    }
    return {
      form,
      title: 'AskUserQuestion',
      acceptLabel: 'Submit',
      rawInput: {
        type: 'AskUserQuestion',
        message: params.message,
        ...(asyncDelivery.safeParse(params._meta).success ? { delivery: 'async' } : {}),
        questions: form.questions.map((question, index) =>
          index === 0 && params.message.trim() !== question.question
            ? {
                ...question,
                header: [params.message, question.header].filter(Boolean).join(' — '),
              }
            : question
        ),
      },
    };
  }
  if (params.mode === 'url') {
    const url = urlRequestSchema.safeParse(params);
    if (url.success) {
      return {
        form: null,
        title: 'Authorize URL',
        acceptLabel: 'Authorize',
        rawInput: { type: 'UrlElicitation', message: params.message, ...url.data },
      };
    }
  }
  return null;
}

function createPermissionRequest(
  params: CreateElicitationRequest,
  fallbackSessionId: string,
  presentation: ElicitationPresentation
): RequestPermissionRequest {
  return {
    sessionId:
      'sessionId' in params && typeof params.sessionId === 'string'
        ? params.sessionId
        : fallbackSessionId,
    toolCall: {
      toolCallId:
        'toolCallId' in params && typeof params.toolCallId === 'string'
          ? params.toolCallId
          : `elicitation:${crypto.randomUUID()}`,
      title: presentation.title,
      status: 'pending',
      rawInput: presentation.rawInput,
    },
    options: [
      { optionId: 'accept', kind: 'allow_once', name: presentation.acceptLabel },
      { optionId: 'decline', kind: 'reject_once', name: 'Decline' },
    ],
  };
}

export type ResolveAcpElicitationResponse = (
  optionId: string | undefined,
  answers: Record<string, string[]> | undefined
) => CreateElicitationResponse;

function resolveResponse(
  optionId: string | undefined,
  answers: Record<string, string[]> | undefined,
  form: AcpElicitationForm | null
): CreateElicitationResponse {
  if (optionId === 'decline') {
    return { action: 'decline' };
  }
  if (optionId !== 'accept') {
    return { action: 'cancel' };
  }
  if (!form) {
    return { action: 'accept' };
  }
  const content = form.parseAnswers(answers);
  return content ? { action: 'accept', content } : { action: 'cancel' };
}

/** Route upstream elicitation through the same explicit user-response lifecycle as permissions. */
export async function createAcpElicitation(
  params: CreateElicitationRequest,
  fallbackSessionId: string,
  requestPermission: (
    request: RequestPermissionRequest,
    presentation: 'form' | 'url',
    resolveElicitationResponse: ResolveAcpElicitationResponse
  ) => Promise<RequestPermissionResponse>
): Promise<CreateElicitationResponse> {
  const presentation = createPresentation(params);
  if (!presentation) {
    return { action: 'cancel' };
  }
  const resolveElicitationResponse: ResolveAcpElicitationResponse = (optionId, answers) =>
    resolveResponse(optionId, answers, presentation.form);
  const response = await requestPermission(
    createPermissionRequest(params, fallbackSessionId, presentation),
    params.mode === 'url' ? 'url' : 'form',
    resolveElicitationResponse
  );
  const optionId = response.outcome.outcome === 'selected' ? response.outcome.optionId : undefined;
  const answers = responseAnswersSchema.safeParse(response._meta).data?.factoryFactory
    .toolUserInputAnswers;
  return resolveElicitationResponse(optionId, answers);
}
