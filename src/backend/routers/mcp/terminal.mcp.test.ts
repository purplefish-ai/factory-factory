import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing
const mockFindById = vi.fn();
const mockGetTerminal = vi.fn();
const mockGetTerminalsForWorkspace = vi.fn();
const mockGetActiveTerminal = vi.fn();

vi.mock('../../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('../../services/terminal.service', () => ({
  terminalService: {
    getTerminal: (...args: unknown[]) => mockGetTerminal(...args),
    getTerminalsForWorkspace: (...args: unknown[]) => mockGetTerminalsForWorkspace(...args),
    getActiveTerminal: (...args: unknown[]) => mockGetActiveTerminal(...args),
  },
}));

vi.mock('../../services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks are set up
import { executeMcpTool } from './server';
import { registerTerminalTools } from './terminal.mcp';
import type { McpToolResponse } from './types';
import { McpErrorCode } from './types';

// Type for the get_output response
interface GetTerminalOutputResult {
  terminals: Array<{
    terminalId: string;
    pid: number;
    output: string;
    lineCount: number;
    truncated: boolean;
    isActive: boolean;
    createdAt: string;
    cols: number;
    rows: number;
  }>;
  totalTerminals: number;
}

// Helper to execute and type the MCP tool
function executeGetOutput(
  agentId: string,
  input: { terminalId?: string; maxLines?: number } = {}
): Promise<McpToolResponse<GetTerminalOutputResult>> {
  return executeMcpTool(agentId, 'mcp__terminal__get_output', input) as Promise<
    McpToolResponse<GetTerminalOutputResult>
  >;
}

// Helper to create mock terminal instances
function createMockTerminal(
  overrides: Partial<{
    id: string;
    workspaceId: string;
    outputBuffer: string;
    createdAt: Date;
    cols: number;
    rows: number;
    pid: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'term-123',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    outputBuffer: overrides.outputBuffer ?? 'line1\nline2\nline3',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    pty: {
      pid: overrides.pid ?? 12_345,
    },
    disposables: [],
  };
}

describe('terminal.mcp', () => {
  const mockWorkspaceId = 'workspace-123';
  const mockAgentId = 'agent-1';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for session lookup
    mockFindById.mockResolvedValue({
      workspaceId: mockWorkspaceId,
      workspace: {
        worktreePath: '/path/to/worktree',
      },
    });

    // Default: no active terminal
    mockGetActiveTerminal.mockReturnValue(null);

    // Default: no terminals
    mockGetTerminalsForWorkspace.mockReturnValue([]);
    mockGetTerminal.mockReturnValue(null);

    // Register tools
    registerTerminalTools();
  });

  describe('mcp__terminal__get_output', () => {
    it('returns empty array when no terminals exist', async () => {
      const result = await executeGetOutput(mockAgentId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals).toHaveLength(0);
        expect(result.data.totalTerminals).toBe(0);
      }
    });

    it('returns all terminals when no terminalId specified', async () => {
      const terminal1 = createMockTerminal({ id: 'term-1', outputBuffer: 'output1' });
      const terminal2 = createMockTerminal({ id: 'term-2', outputBuffer: 'output2' });
      mockGetTerminalsForWorkspace.mockReturnValue([terminal1, terminal2]);

      const result = await executeGetOutput(mockAgentId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals).toHaveLength(2);
        expect(result.data.totalTerminals).toBe(2);
        expect(result.data.terminals[0]!.terminalId).toBe('term-1');
        expect(result.data.terminals[0]!.output).toBe('output1');
        expect(result.data.terminals[1]!.terminalId).toBe('term-2');
        expect(result.data.terminals[1]!.output).toBe('output2');
      }
    });

    it('returns specific terminal when terminalId provided', async () => {
      const terminal = createMockTerminal({ id: 'term-specific', outputBuffer: 'specific output' });
      mockGetTerminal.mockReturnValue(terminal);

      const result = await executeGetOutput(mockAgentId, { terminalId: 'term-specific' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals).toHaveLength(1);
        expect(result.data.terminals[0]!.terminalId).toBe('term-specific');
        expect(result.data.terminals[0]!.output).toBe('specific output');
      }
      expect(mockGetTerminal).toHaveBeenCalledWith(mockWorkspaceId, 'term-specific');
    });

    it('returns active terminal when terminalId is "active"', async () => {
      const activeTerminal = createMockTerminal({
        id: 'term-active',
        outputBuffer: 'active output',
      });
      mockGetActiveTerminal.mockReturnValue('term-active');
      mockGetTerminal.mockReturnValue(activeTerminal);

      const result = await executeGetOutput(mockAgentId, { terminalId: 'active' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals).toHaveLength(1);
        expect(result.data.terminals[0]!.terminalId).toBe('term-active');
        expect(result.data.terminals[0]!.isActive).toBe(true);
      }
    });

    it('falls back to first terminal when no active set and terminalId is "active"', async () => {
      const terminal = createMockTerminal({ id: 'term-first', outputBuffer: 'first output' });
      mockGetActiveTerminal.mockReturnValue(null);
      mockGetTerminalsForWorkspace.mockReturnValue([terminal]);

      const result = await executeGetOutput(mockAgentId, { terminalId: 'active' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals).toHaveLength(1);
        expect(result.data.terminals[0]!.terminalId).toBe('term-first');
      }
    });

    it('truncates output when maxLines specified', async () => {
      const terminal = createMockTerminal({
        id: 'term-1',
        outputBuffer: 'line1\nline2\nline3\nline4\nline5',
      });
      mockGetTerminalsForWorkspace.mockReturnValue([terminal]);

      const result = await executeGetOutput(mockAgentId, { maxLines: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals[0]!.output).toBe('line4\nline5');
        expect(result.data.terminals[0]!.truncated).toBe(true);
        expect(result.data.terminals[0]!.lineCount).toBe(2);
      }
    });

    it('marks truncated: false when lines are not cut', async () => {
      const terminal = createMockTerminal({
        id: 'term-1',
        outputBuffer: 'line1\nline2',
      });
      mockGetTerminalsForWorkspace.mockReturnValue([terminal]);

      const result = await executeGetOutput(mockAgentId, { maxLines: 10 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals[0]!.output).toBe('line1\nline2');
        expect(result.data.terminals[0]!.truncated).toBe(false);
      }
    });

    it('returns WORKSPACE_NOT_FOUND for invalid agentId', async () => {
      mockFindById.mockResolvedValue(null);

      const result = await executeGetOutput('invalid-agent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.WORKSPACE_NOT_FOUND);
      }
    });

    it('returns RESOURCE_NOT_FOUND for invalid terminalId', async () => {
      mockGetTerminal.mockReturnValue(null);

      const result = await executeGetOutput(mockAgentId, { terminalId: 'nonexistent-terminal' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.RESOURCE_NOT_FOUND);
        expect(result.error.message).toContain('nonexistent-terminal');
      }
    });

    it('returns RESOURCE_NOT_FOUND when active requested but no terminals exist', async () => {
      mockGetActiveTerminal.mockReturnValue(null);
      mockGetTerminalsForWorkspace.mockReturnValue([]);

      const result = await executeGetOutput(mockAgentId, { terminalId: 'active' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.RESOURCE_NOT_FOUND);
        expect(result.error.message).toContain('active');
      }
    });

    it('includes isActive flag correctly for each terminal', async () => {
      const terminal1 = createMockTerminal({ id: 'term-1' });
      const terminal2 = createMockTerminal({ id: 'term-2' });
      mockGetTerminalsForWorkspace.mockReturnValue([terminal1, terminal2]);
      mockGetActiveTerminal.mockReturnValue('term-2');

      const result = await executeGetOutput(mockAgentId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.terminals[0]!.isActive).toBe(false);
        expect(result.data.terminals[1]!.isActive).toBe(true);
      }
    });

    it('includes terminal metadata in response', async () => {
      const terminal = createMockTerminal({
        id: 'term-1',
        cols: 120,
        rows: 40,
        pid: 54_321,
        createdAt: new Date('2024-06-15T10:30:00Z'),
      });
      mockGetTerminalsForWorkspace.mockReturnValue([terminal]);

      const result = await executeGetOutput(mockAgentId);

      expect(result.success).toBe(true);
      if (result.success) {
        const t = result.data.terminals[0]!;
        expect(t.cols).toBe(120);
        expect(t.rows).toBe(40);
        expect(t.pid).toBe(54_321);
        expect(t.createdAt).toBe('2024-06-15T10:30:00.000Z');
      }
    });

    it('returns INVALID_INPUT for invalid maxLines', async () => {
      const result = await executeGetOutput(mockAgentId, { maxLines: -5 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(McpErrorCode.INVALID_INPUT);
      }
    });
  });
});
