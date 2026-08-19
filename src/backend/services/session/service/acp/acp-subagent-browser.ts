import { z } from 'zod';
import {
  SUBAGENTS_LIST_METHOD,
  SUBAGENTS_READ_METHOD,
  type SubagentBrowseCapability,
  type SubagentListParams,
  type SubagentListResult,
  type SubagentReadParams,
  type SubagentReadResult,
  subagentListParamsSchema,
  subagentListResultSchema,
  subagentReadParamsSchema,
  subagentReadResultSchema,
} from '@/shared/acp-protocol/subagents';
import type { AcpProcessHandle } from './acp-process-handle';
import { AcpSubagentBrowseError, getAcpErrorLogDetails } from './acp-runtime-errors';

type SubagentBrowseOperation = 'list' | 'transcript';

function subagentBrowseMessage(
  operation: SubagentBrowseOperation,
  kind: 'invalid' | 'not_found' | 'protocol' | 'failed'
): string {
  const subject = operation === 'list' ? 'Sub-agent list' : 'Sub-agent transcript';
  if (kind === 'invalid') {
    return `Invalid ${subject.toLowerCase()} request.`;
  }
  if (kind === 'not_found') {
    return `${subject} not found for this session.`;
  }
  if (kind === 'protocol') {
    return `${subject} is unavailable because the provider returned an invalid response.`;
  }
  return `${subject} request failed.`;
}

function normalizeSubagentBrowseError(
  error: unknown,
  operation: SubagentBrowseOperation
): AcpSubagentBrowseError {
  if (error instanceof AcpSubagentBrowseError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new AcpSubagentBrowseError(
      'PRECONDITION_FAILED',
      subagentBrowseMessage(operation, 'protocol'),
      { cause: error }
    );
  }

  const details = getAcpErrorLogDetails(error);
  if (details.code === -32_602) {
    return new AcpSubagentBrowseError(
      'INVALID_INPUT',
      subagentBrowseMessage(operation, 'invalid'),
      { cause: error }
    );
  }
  if (details.code === -32_002) {
    return new AcpSubagentBrowseError('NOT_FOUND', subagentBrowseMessage(operation, 'not_found'), {
      cause: error,
    });
  }
  if (details.code === -32_601) {
    return new AcpSubagentBrowseError(
      'PRECONDITION_FAILED',
      'Sub-agent browsing is unavailable for this session.',
      { cause: error }
    );
  }
  if (details.code === -32_000) {
    return new AcpSubagentBrowseError(
      'PRECONDITION_FAILED',
      'Provider authentication is required for sub-agent browsing.',
      { cause: error }
    );
  }
  if (details.code === -32_603 || details.code === -32_600 || details.code === -32_700) {
    return new AcpSubagentBrowseError(
      'PRECONDITION_FAILED',
      subagentBrowseMessage(operation, 'protocol'),
      { cause: error }
    );
  }
  return new AcpSubagentBrowseError('INTERNAL_ERROR', subagentBrowseMessage(operation, 'failed'), {
    cause: error,
  });
}

export class AcpSubagentBrowser {
  getCapability(handle: AcpProcessHandle | undefined): SubagentBrowseCapability | null {
    return handle?.getSubagentBrowseCapability() ?? null;
  }

  async listSubagents(
    handle: AcpProcessHandle | undefined,
    input: Omit<SubagentListParams, 'sessionId'>
  ): Promise<SubagentListResult> {
    const browseHandle = this.requireHandle(handle);
    const parsedParams = subagentListParamsSchema.safeParse({
      ...input,
      sessionId: browseHandle.providerSessionId,
    });
    if (!parsedParams.success) {
      throw new AcpSubagentBrowseError('INVALID_INPUT', subagentBrowseMessage('list', 'invalid'), {
        cause: parsedParams.error,
      });
    }
    try {
      const response = await browseHandle.connection.extMethod(
        SUBAGENTS_LIST_METHOD,
        parsedParams.data
      );
      return subagentListResultSchema.parse(response);
    } catch (error) {
      throw normalizeSubagentBrowseError(error, 'list');
    }
  }

  async readSubagentTranscript(
    handle: AcpProcessHandle | undefined,
    input: Omit<SubagentReadParams, 'sessionId'>
  ): Promise<SubagentReadResult> {
    const browseHandle = this.requireHandle(handle);
    const parsedParams = subagentReadParamsSchema.safeParse({
      ...input,
      sessionId: browseHandle.providerSessionId,
    });
    if (!parsedParams.success) {
      throw new AcpSubagentBrowseError(
        'INVALID_INPUT',
        subagentBrowseMessage('transcript', 'invalid'),
        { cause: parsedParams.error }
      );
    }
    try {
      const response = await browseHandle.connection.extMethod(
        SUBAGENTS_READ_METHOD,
        parsedParams.data
      );
      return subagentReadResultSchema.parse(response);
    } catch (error) {
      throw normalizeSubagentBrowseError(error, 'transcript');
    }
  }

  private requireHandle(handle: AcpProcessHandle | undefined): AcpProcessHandle {
    if (!handle) {
      throw new AcpSubagentBrowseError(
        'PRECONDITION_FAILED',
        'Sub-agent browsing requires a running parent session.'
      );
    }
    if (!handle.getSubagentBrowseCapability()) {
      throw new AcpSubagentBrowseError(
        'PRECONDITION_FAILED',
        'Sub-agent browsing is unavailable for this session.'
      );
    }
    return handle;
  }
}
