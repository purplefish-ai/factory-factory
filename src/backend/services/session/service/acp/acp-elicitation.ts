import crypto from 'node:crypto';
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { z } from 'zod';
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

type ElicitationPresentation = {
  title: string;
  acceptLabel: string;
  rawInput: Record<string, unknown>;
  form: AcpElicitationForm | null;
};

function createPresentation(params: CreateElicitationRequest): ElicitationPresentation | null {
  if (params.mode === 'form' && 'requestedSchema' in params) {
    const form = createAcpElicitationForm(params.requestedSchema);
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
        questions: form.questions.map((question, index) =>
          index === 0
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

function convertResponse(
  response: RequestPermissionResponse,
  form: AcpElicitationForm | null
): CreateElicitationResponse {
  if (response.outcome.outcome !== 'selected') {
    return { action: 'cancel' };
  }
  if (response.outcome.optionId === 'decline') {
    return { action: 'decline' };
  }
  if (response.outcome.optionId !== 'accept') {
    return { action: 'cancel' };
  }
  if (!form) {
    return { action: 'accept' };
  }
  const answers = responseAnswersSchema.safeParse(response._meta);
  const content = form.parseAnswers(
    answers.success ? answers.data.factoryFactory.toolUserInputAnswers : undefined
  );
  return content ? { action: 'accept', content } : { action: 'cancel' };
}

/** Route upstream elicitation through the same explicit user-response lifecycle as permissions. */
export async function createAcpElicitation(
  params: CreateElicitationRequest,
  fallbackSessionId: string,
  requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
): Promise<CreateElicitationResponse> {
  const presentation = createPresentation(params);
  if (!presentation) {
    return { action: 'cancel' };
  }
  const response = await requestPermission(
    createPermissionRequest(params, fallbackSessionId, presentation)
  );
  return convertResponse(response, presentation.form);
}
