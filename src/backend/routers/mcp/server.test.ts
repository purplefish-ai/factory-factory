import { AgentType } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../../testing/factories';
import { McpErrorCode } from './types';

// Hoist mock definitions
const mockAgentAccessor = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

const mockDecisionLogAccessor = vi.hoisted(() => ({
  createAutomatic: vi.fn(),
}));

const mockCheckToolPermissions = vi.hoisted(() => vi.fn());
const mockEscalateCriticalError = vi.hoisted(() => vi.fn());
const mockEscalateToolFailure = vi.hoisted(() => vi.fn());
const mockIsTransientError = vi.hoisted(() => vi.fn());

vi.mock('../../resource_accessors/index.js', () => ({
  agentAccessor: mockAgentAccessor,
  decisionLogAccessor: mockDecisionLogAccessor,
}));

vi.mock('./permissions.js', () => ({
  checkToolPermissions: mockCheckToolPermissions,
}));

vi.mock('./errors.js', () => ({
  CRITICAL_TOOLS: ['mcp__task__approve'],
  escalateCriticalError: mockEscalateCriticalError,
  escalateToolFailure: mockEscalateToolFailure,
  isTransientError: mockIsTransientError,
}));

// Import after mocking
import {
  createErrorResponse,
  createSuccessResponse,
  executeMcpTool,
  getRegisteredTools,
  getTool,
  registerMcpTool,
} from './server';

describe('MCP Tool Registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerMcpTool', () => {
    it('should register a tool in the registry', () => {
      const toolEntry = {
        name: 'mcp__test__tool',
        description: 'Test tool',
        handler: vi.fn().mockResolvedValue({ success: true, data: 'test', timestamp: new Date() }),
      };

      registerMcpTool(toolEntry);

      const registeredTool = getTool('mcp__test__tool');
      expect(registeredTool).toBeDefined();
      expect(registeredTool?.name).toBe('mcp__test__tool');
    });

    it('should overwrite existing tool with same name', () => {
      const tool1 = {
        name: 'mcp__test__overwrite',
        description: 'First version',
        handler: vi.fn(),
      };
      const tool2 = {
        name: 'mcp__test__overwrite',
        description: 'Second version',
        handler: vi.fn(),
      };

      registerMcpTool(tool1);
      registerMcpTool(tool2);

      const registeredTool = getTool('mcp__test__overwrite');
      expect(registeredTool?.description).toBe('Second version');
    });
  });

  describe('getRegisteredTools', () => {
    it('should return all registered tools', () => {
      registerMcpTool({
        name: 'mcp__test__tool1',
        description: 'Tool 1',
        handler: vi.fn(),
      });
      registerMcpTool({
        name: 'mcp__test__tool2',
        description: 'Tool 2',
        handler: vi.fn(),
      });

      const tools = getRegisteredTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain('mcp__test__tool1');
      expect(toolNames).toContain('mcp__test__tool2');
    });
  });

  describe('getTool', () => {
    it('should return tool if it exists', () => {
      registerMcpTool({
        name: 'mcp__test__get',
        description: 'Get test',
        handler: vi.fn(),
      });

      const tool = getTool('mcp__test__get');
      expect(tool).toBeDefined();
    });

    it('should return undefined for non-existent tool', () => {
      const tool = getTool('mcp__nonexistent__tool');
      expect(tool).toBeUndefined();
    });
  });
});

describe('executeMcpTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTransientError.mockReturnValue(false);
  });

  describe('validation', () => {
    it('should return error if agent not found', async () => {
      mockAgentAccessor.findById.mockResolvedValue(null);

      const result = await executeMcpTool('non-existent-agent', 'mcp__test__tool', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.AGENT_NOT_FOUND);
      }
    });

    it('should return error if tool not found', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);

      const result = await executeMcpTool(agent.id, 'mcp__nonexistent__tool', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.TOOL_NOT_FOUND);
      }
    });

    it('should return error if permission denied', async () => {
      const agent = createAgent({ type: AgentType.WORKER });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({
        allowed: false,
        reason: 'Not allowed for workers',
      });

      registerMcpTool({
        name: 'mcp__test__permission',
        description: 'Permission test',
        handler: vi.fn(),
      });

      const result = await executeMcpTool(agent.id, 'mcp__test__permission', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.PERMISSION_DENIED);
      }
    });
  });

  describe('successful execution', () => {
    it('should execute tool and return result', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockAgentAccessor.update.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({ allowed: true });
      mockDecisionLogAccessor.createAutomatic.mockResolvedValue({});

      const expectedResult = { success: true, data: { message: 'success' }, timestamp: new Date() };
      const handler = vi.fn().mockResolvedValue(expectedResult);

      registerMcpTool({
        name: 'mcp__test__success',
        description: 'Success test',
        handler,
      });

      const result = await executeMcpTool(agent.id, 'mcp__test__success', { input: 'test' });

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledWith({ agentId: agent.id }, { input: 'test' });
    });

    it('should update agent lastActiveAt on success', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockAgentAccessor.update.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({ allowed: true });
      mockDecisionLogAccessor.createAutomatic.mockResolvedValue({});

      registerMcpTool({
        name: 'mcp__test__heartbeat',
        description: 'Heartbeat test',
        handler: vi.fn().mockResolvedValue({ success: true, data: {}, timestamp: new Date() }),
      });

      await executeMcpTool(agent.id, 'mcp__test__heartbeat', {});

      expect(mockAgentAccessor.update).toHaveBeenCalledWith(agent.id, {
        lastHeartbeat: expect.any(Date),
      });
    });

    it('should log tool invocation and result', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockAgentAccessor.update.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({ allowed: true });
      mockDecisionLogAccessor.createAutomatic.mockResolvedValue({});

      registerMcpTool({
        name: 'mcp__test__logging',
        description: 'Logging test',
        handler: vi.fn().mockResolvedValue({ success: true, data: {}, timestamp: new Date() }),
      });

      await executeMcpTool(agent.id, 'mcp__test__logging', { foo: 'bar' });

      expect(mockDecisionLogAccessor.createAutomatic).toHaveBeenCalledWith(
        agent.id,
        'mcp__test__logging',
        'invocation',
        { foo: 'bar' }
      );
      expect(mockDecisionLogAccessor.createAutomatic).toHaveBeenCalledWith(
        agent.id,
        'mcp__test__logging',
        'result',
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should handle tool execution errors', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({ allowed: true });
      mockDecisionLogAccessor.createAutomatic.mockResolvedValue({});
      mockIsTransientError.mockReturnValue(false);

      const error = new Error('Tool execution failed');
      registerMcpTool({
        name: 'mcp__test__error',
        description: 'Error test',
        handler: vi.fn().mockRejectedValue(error),
      });

      const result = await executeMcpTool(agent.id, 'mcp__test__error', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.INTERNAL_ERROR);
        expect(result.error.message).toContain('Tool execution failed');
      }
    });

    it('should escalate critical tool failures', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({ allowed: true });
      mockDecisionLogAccessor.createAutomatic.mockResolvedValue({});
      mockIsTransientError.mockReturnValue(false);

      const error = new Error('Approval failed');
      registerMcpTool({
        name: 'mcp__task__approve',
        description: 'Approve test',
        handler: vi.fn().mockRejectedValue(error),
      });

      await executeMcpTool(agent.id, 'mcp__task__approve', {});

      expect(mockEscalateCriticalError).toHaveBeenCalledWith(agent, 'mcp__task__approve', error);
    });

    it('should escalate non-critical tool failures', async () => {
      const agent = createAgent({ type: AgentType.SUPERVISOR });
      mockAgentAccessor.findById.mockResolvedValue(agent);
      mockCheckToolPermissions.mockReturnValue({ allowed: true });
      mockDecisionLogAccessor.createAutomatic.mockResolvedValue({});
      mockIsTransientError.mockReturnValue(false);

      const error = new Error('Non-critical failure');
      registerMcpTool({
        name: 'mcp__test__noncritical',
        description: 'Non-critical test',
        handler: vi.fn().mockRejectedValue(error),
      });

      await executeMcpTool(agent.id, 'mcp__test__noncritical', {});

      expect(mockEscalateToolFailure).toHaveBeenCalledWith(agent, 'mcp__test__noncritical', error);
    });
  });
});

describe('Response Helpers', () => {
  describe('createSuccessResponse', () => {
    it('should create a success response with data', () => {
      const data = { message: 'Hello', count: 42 };
      const response = createSuccessResponse(data);

      expect(response.success).toBe(true);
      if (response.success) {
        expect(response.data).toEqual(data);
      }
      expect(response.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('createErrorResponse', () => {
    it('should create an error response with code and message', () => {
      const response = createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'You do not have permission'
      );

      expect(response.success).toBe(false);
      if (!response.success) {
        expect(response.error.code).toBe(McpErrorCode.PERMISSION_DENIED);
        expect(response.error.message).toBe('You do not have permission');
      }
      expect(response.timestamp).toBeInstanceOf(Date);
    });

    it('should include details if provided', () => {
      const details = { field: 'email', error: 'invalid format' };
      const response = createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Validation failed',
        details
      );

      if (!response.success) {
        expect(response.error.details).toEqual(details);
      }
    });
  });
});
