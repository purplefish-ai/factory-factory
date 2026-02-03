import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../app-context';

// Mock dependencies before importing the router
const mockExecuteMcpTool = vi.fn();

vi.mock('../mcp/index', () => ({
  executeMcpTool: (...args: unknown[]) => mockExecuteMcpTool(...args),
}));

import { createMcpRouter } from './mcp.router';

// Helper to create mock Request/Response
function createMockReqRes(body: Record<string, unknown> = {}) {
  const req = {
    body,
  } as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

// Get the route handler from the router
function getExecuteHandler(router: ReturnType<typeof createMcpRouter>) {
  // Access the router's stack to get the handler for POST /execute
  const layer = router.stack.find((l) => {
    const route = l.route as { path?: string; methods?: Record<string, boolean> } | undefined;
    return route?.path === '/execute' && route?.methods?.post;
  });
  const route = layer?.route as { stack?: Array<{ handle?: unknown }> } | undefined;
  if (!route?.stack?.[0]?.handle) {
    throw new Error('Could not find POST /execute handler');
  }
  return route.stack[0].handle as (
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<void>;
}

describe('mcpRouter', () => {
  let executeHandler: ReturnType<typeof getExecuteHandler>;
  let router: ReturnType<typeof createMcpRouter>;

  beforeEach(() => {
    vi.clearAllMocks();
    const appContext = {
      services: {
        createLogger: () => ({
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
      },
    } as unknown as AppContext;
    router = createMcpRouter(appContext);
    executeHandler = getExecuteHandler(router);
  });

  describe('POST /execute - validation', () => {
    it('returns 400 when agentId is missing', async () => {
      const { req, res, next } = createMockReqRes({ toolName: 'test-tool' });

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: agentId',
        },
      });
      expect(mockExecuteMcpTool).not.toHaveBeenCalled();
    });

    it('returns 400 when toolName is missing', async () => {
      const { req, res, next } = createMockReqRes({ agentId: 'agent-123' });

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: toolName',
        },
      });
      expect(mockExecuteMcpTool).not.toHaveBeenCalled();
    });

    it('returns 400 when both agentId and toolName are missing', async () => {
      const { req, res, next } = createMockReqRes({});

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: agentId',
        },
      });
      expect(mockExecuteMcpTool).not.toHaveBeenCalled();
    });
  });

  describe('POST /execute - success', () => {
    it('returns 200 with result when tool executes successfully', async () => {
      const mockResult = {
        success: true,
        data: { message: 'Tool executed successfully' },
        timestamp: new Date().toISOString(),
      };
      mockExecuteMcpTool.mockResolvedValue(mockResult);

      const { req, res, next } = createMockReqRes({
        agentId: 'agent-123',
        toolName: 'test-tool',
        input: { param: 'value' },
      });

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockResult);
    });

    it('passes correct arguments to executeMcpTool', async () => {
      const mockResult = {
        success: true,
        data: { result: 'ok' },
        timestamp: new Date().toISOString(),
      };
      mockExecuteMcpTool.mockResolvedValue(mockResult);

      const { req, res, next } = createMockReqRes({
        agentId: 'agent-abc',
        toolName: 'my-custom-tool',
        input: { foo: 'bar', nested: { key: 'value' } },
      });

      await executeHandler(req, res, next);

      expect(mockExecuteMcpTool).toHaveBeenCalledTimes(1);
      expect(mockExecuteMcpTool).toHaveBeenCalledWith('agent-abc', 'my-custom-tool', {
        foo: 'bar',
        nested: { key: 'value' },
      });
    });

    it('uses empty object as default input when not provided', async () => {
      const mockResult = {
        success: true,
        data: {},
        timestamp: new Date().toISOString(),
      };
      mockExecuteMcpTool.mockResolvedValue(mockResult);

      const { req, res, next } = createMockReqRes({
        agentId: 'agent-123',
        toolName: 'test-tool',
      });

      await executeHandler(req, res, next);

      expect(mockExecuteMcpTool).toHaveBeenCalledWith('agent-123', 'test-tool', {});
    });
  });

  describe('POST /execute - errors', () => {
    it('returns 400 when tool execution returns error', async () => {
      const mockErrorResult = {
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: "Tool 'unknown-tool' not found in registry",
        },
        timestamp: new Date().toISOString(),
      };
      mockExecuteMcpTool.mockResolvedValue(mockErrorResult);

      const { req, res, next } = createMockReqRes({
        agentId: 'agent-123',
        toolName: 'unknown-tool',
        input: {},
      });

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(mockErrorResult);
    });

    it('returns 500 on internal errors', async () => {
      mockExecuteMcpTool.mockRejectedValue(new Error('Database connection failed'));

      const { req, res, next } = createMockReqRes({
        agentId: 'agent-123',
        toolName: 'test-tool',
        input: {},
      });

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Database connection failed',
        },
      });
    });

    it('returns 500 with generic message for non-Error exceptions', async () => {
      mockExecuteMcpTool.mockRejectedValue('String error');

      const { req, res, next } = createMockReqRes({
        agentId: 'agent-123',
        toolName: 'test-tool',
        input: {},
      });

      await executeHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unknown error',
        },
      });
    });
  });
});
