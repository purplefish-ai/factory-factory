import { z } from 'zod';
import { fileLockService } from '../../services/file-lock.service';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server';
import type { McpToolContext, McpToolResponse } from './types';
import { McpErrorCode } from './types';

// ============================================================================
// Input Schemas
// ============================================================================

const AcquireLockInputSchema = z.object({
  filePath: z.string().min(1),
  ttlSeconds: z.number().min(60).max(3600).optional(),
  ownerLabel: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ReleaseLockInputSchema = z.object({
  filePath: z.string().min(1),
  force: z.boolean().optional(),
});

const CheckLockInputSchema = z.object({
  filePath: z.string().min(1),
});

const ListLocksInputSchema = z.object({
  includeExpired: z.boolean().optional(),
});

const ReleaseAllLocksInputSchema = z.object({});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Acquire an advisory lock on a file
 */
async function acquireLock(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = AcquireLockInputSchema.parse(input);
    const result = await fileLockService.acquireLock(context.agentId, parsed);
    return createSuccessResponse(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    if (error instanceof Error && error.message === 'Could not resolve workspace for agent') {
      return createErrorResponse(
        McpErrorCode.WORKSPACE_NOT_FOUND,
        'Could not resolve workspace for agent'
      );
    }
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Path traversal not allowed');
    }
    throw error;
  }
}

/**
 * Release an advisory lock on a file
 */
async function releaseLock(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = ReleaseLockInputSchema.parse(input);
    const result = await fileLockService.releaseLock(context.agentId, parsed);
    return createSuccessResponse(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    if (error instanceof Error && error.message === 'Could not resolve workspace for agent') {
      return createErrorResponse(
        McpErrorCode.WORKSPACE_NOT_FOUND,
        'Could not resolve workspace for agent'
      );
    }
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Path traversal not allowed');
    }
    throw error;
  }
}

/**
 * Check if a file is locked
 */
async function checkLock(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = CheckLockInputSchema.parse(input);
    const result = await fileLockService.checkLock(context.agentId, parsed);
    return createSuccessResponse(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    if (error instanceof Error && error.message === 'Could not resolve workspace for agent') {
      return createErrorResponse(
        McpErrorCode.WORKSPACE_NOT_FOUND,
        'Could not resolve workspace for agent'
      );
    }
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Path traversal not allowed');
    }
    throw error;
  }
}

/**
 * List all locks in the workspace
 */
async function listLocks(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = ListLocksInputSchema.parse(input);
    const result = await fileLockService.listLocks(context.agentId, parsed);
    return createSuccessResponse(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    if (error instanceof Error && error.message === 'Could not resolve workspace for agent') {
      return createErrorResponse(
        McpErrorCode.WORKSPACE_NOT_FOUND,
        'Could not resolve workspace for agent'
      );
    }
    throw error;
  }
}

/**
 * Release all locks held by the current agent
 */
async function releaseAllLocks(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    ReleaseAllLocksInputSchema.parse(input);
    const result = await fileLockService.releaseAllLocks(context.agentId);
    return createSuccessResponse(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    if (error instanceof Error && error.message === 'Could not resolve workspace for agent') {
      return createErrorResponse(
        McpErrorCode.WORKSPACE_NOT_FOUND,
        'Could not resolve workspace for agent'
      );
    }
    throw error;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerLockTools(): void {
  registerMcpTool({
    name: 'mcp__lock__acquire',
    description:
      'Acquire an advisory lock on a file. Returns whether the lock was acquired, or info about the existing lock holder if not.',
    handler: acquireLock,
    schema: AcquireLockInputSchema,
  });

  registerMcpTool({
    name: 'mcp__lock__release',
    description:
      'Release an advisory lock on a file. By default, only the lock owner can release. Use force=true to override.',
    handler: releaseLock,
    schema: ReleaseLockInputSchema,
  });

  registerMcpTool({
    name: 'mcp__lock__check',
    description: 'Check if a file is locked and get information about the lock holder.',
    handler: checkLock,
    schema: CheckLockInputSchema,
  });

  registerMcpTool({
    name: 'mcp__lock__list',
    description:
      'List all advisory locks in the workspace. Shows which files are locked and by whom.',
    handler: listLocks,
    schema: ListLocksInputSchema,
  });

  registerMcpTool({
    name: 'mcp__lock__release_all',
    description: 'Release all advisory locks held by the current agent in the workspace.',
    handler: releaseAllLocks,
    schema: ReleaseAllLocksInputSchema,
  });
}
