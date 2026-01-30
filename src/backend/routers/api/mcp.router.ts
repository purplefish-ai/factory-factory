import { Router } from 'express';
import { HTTP_STATUS } from '../../constants';
import { createLogger } from '../../services/index';
import { executeMcpTool } from '../mcp/index';

const router = Router();
const logger = createLogger('api:mcp');

// ============================================================================
// MCP Tool Execution Routes
// ============================================================================

/**
 * POST /mcp/execute
 * Execute an MCP tool with the given input
 */
router.post('/execute', async (req, res) => {
  try {
    const { agentId, toolName, input } = req.body;

    if (!agentId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Missing required field: agentId' },
      });
    }

    if (!toolName) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Missing required field: toolName' },
      });
    }

    const result = await executeMcpTool(agentId, toolName, input || {});
    const statusCode = result.success ? HTTP_STATUS.OK : HTTP_STATUS.BAD_REQUEST;
    return res.status(statusCode).json(result);
  } catch (error) {
    logger.error('Error executing MCP tool', error as Error);
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

export { router as mcpRouter };
