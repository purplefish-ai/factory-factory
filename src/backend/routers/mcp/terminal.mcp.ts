import { z } from 'zod';
import { claudeSessionAccessor } from '../../resource_accessors/claude-session.accessor';
import type { TerminalInstance } from '../../services/terminal.service';
import { terminalService } from '../../services/terminal.service';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server';
import type { McpToolContext, McpToolResponse } from './types';
import { McpErrorCode } from './types';

// ============================================================================
// Input Schemas
// ============================================================================

const GetTerminalOutputInputSchema = z.object({
  terminalId: z
    .string()
    .optional()
    .describe(
      'Terminal ID to get output from. Use "active" for the currently active terminal, or omit to get all terminals.'
    ),
  maxLines: z.number().int().positive().optional().describe('Limit output to the last N lines'),
});

// ============================================================================
// Result Types
// ============================================================================

interface TerminalOutputInfo {
  terminalId: string;
  pid: number;
  output: string;
  lineCount: number;
  truncated: boolean;
  isActive: boolean;
  createdAt: string;
  cols: number;
  rows: number;
}

interface GetTerminalOutputResult {
  terminals: TerminalOutputInfo[];
  totalTerminals: number;
}

// ============================================================================
// Workspace Resolution
// ============================================================================

async function resolveWorkspaceId(agentId: string): Promise<string | null> {
  try {
    const session = await claudeSessionAccessor.findById(agentId);
    if (!session?.workspace) {
      return null;
    }
    return session.workspaceId;
  } catch {
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function truncateToLastNLines(
  output: string,
  maxLines: number
): { output: string; truncated: boolean } {
  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return { output, truncated: false };
  }
  return {
    output: lines.slice(-maxLines).join('\n'),
    truncated: true,
  };
}

function getActiveOrFirstTerminal(workspaceId: string): TerminalInstance | null {
  const activeTerminalId = terminalService.getActiveTerminal(workspaceId);
  if (activeTerminalId) {
    return terminalService.getTerminal(workspaceId, activeTerminalId);
  }
  // Fall back to first available terminal
  const allTerminals = terminalService.getTerminalsForWorkspace(workspaceId);
  return allTerminals.length > 0 ? (allTerminals[0] ?? null) : null;
}

function formatTerminalOutput(
  terminal: TerminalInstance,
  maxLines: number | undefined,
  activeTerminalId: string | null
): TerminalOutputInfo {
  let output = terminal.outputBuffer;
  let truncated = false;

  if (maxLines) {
    const result = truncateToLastNLines(output, maxLines);
    output = result.output;
    truncated = result.truncated;
  }

  return {
    terminalId: terminal.id,
    pid: terminal.pty.pid,
    output,
    lineCount: output.split('\n').length,
    truncated,
    isActive: terminal.id === activeTerminalId,
    createdAt: terminal.createdAt.toISOString(),
    cols: terminal.cols,
    rows: terminal.rows,
  };
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function getTerminalOutput(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse<GetTerminalOutputResult>> {
  try {
    const parsed = GetTerminalOutputInputSchema.parse(input);

    // Resolve workspace from agent
    const workspaceId = await resolveWorkspaceId(context.agentId);
    if (!workspaceId) {
      return createErrorResponse(
        McpErrorCode.WORKSPACE_NOT_FOUND,
        'Could not resolve workspace for agent'
      );
    }

    const activeTerminalId = terminalService.getActiveTerminal(workspaceId);

    // Get terminals based on request
    const terminals = getTerminalsForRequest(workspaceId, parsed.terminalId);
    if (terminals === null) {
      const errorMessage =
        parsed.terminalId === 'active'
          ? 'No active terminal found in workspace'
          : `Terminal '${parsed.terminalId}' not found in workspace`;
      return createErrorResponse(McpErrorCode.RESOURCE_NOT_FOUND, errorMessage);
    }

    const results = terminals.map((terminal) =>
      formatTerminalOutput(terminal, parsed.maxLines, activeTerminalId)
    );

    return createSuccessResponse({
      terminals: results,
      totalTerminals: results.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

function getTerminalsForRequest(
  workspaceId: string,
  terminalId: string | undefined
): TerminalInstance[] | null {
  if (terminalId === 'active') {
    const terminal = getActiveOrFirstTerminal(workspaceId);
    return terminal ? [terminal] : null;
  }

  if (terminalId) {
    const terminal = terminalService.getTerminal(workspaceId, terminalId);
    return terminal ? [terminal] : null;
  }

  // Get all terminals
  return terminalService.getTerminalsForWorkspace(workspaceId);
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerTerminalTools(): void {
  registerMcpTool({
    name: 'mcp__terminal__get_output',
    description:
      'Read terminal output from the workspace. Returns buffered output (up to 100KB per terminal). ' +
      'Use terminalId="active" to get the terminal the user is currently viewing, ' +
      'provide a specific terminalId, or omit to get all terminals. ' +
      'Use maxLines to limit output to the last N lines.',
    handler: getTerminalOutput,
    schema: GetTerminalOutputInputSchema,
  });
}
