import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from './inngest/client';
import { initializeMcpTools, executeMcpTool } from './routers/mcp/index.js';
import { mailSentHandler, taskCreatedHandler } from './inngest/functions/index.js';
import { readSessionOutput, listTmuxSessions } from './clients/terminal.client.js';
import { taskRouter } from './routers/api/task.router.js';
import { epicRouter } from './routers/api/epic.router.js';

const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

app.use(express.json());

// Initialize MCP tools
initializeMcpTools();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'factoryfactory-backend',
  });
});

// MCP tool execution endpoint
app.post('/mcp/execute', async (req, res) => {
  try {
    const { agentId, toolName, input } = req.body;

    // Validate required fields
    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: agentId',
        },
      });
    }

    if (!toolName) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: toolName',
        },
      });
    }

    // Execute the tool
    const result = await executeMcpTool(agentId, toolName, input || {});

    // Return result with appropriate status code
    const statusCode = result.success ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error('Error executing MCP tool:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

// Task API routes
app.use('/api/tasks', taskRouter);

// Epic API routes
app.use('/api/epics', epicRouter);

app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [mailSentHandler, taskCreatedHandler],
  })
);

// Terminal API endpoints
app.get('/api/terminal/sessions', async (_req, res) => {
  try {
    const sessions = await listTmuxSessions();
    res.json({ sessions });
  } catch (error) {
    console.error('Error listing tmux sessions:', error);
    res.status(500).json({
      error: 'Failed to list tmux sessions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/terminal/session/:sessionName/output', async (req, res) => {
  try {
    const { sessionName } = req.params;
    const output = await readSessionOutput(sessionName);
    res.json({ output, sessionName });
  } catch (error) {
    console.error('Error reading session output:', error);
    res.status(500).json({
      error: 'Failed to read session output',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Inngest endpoint: http://localhost:${PORT}/api/inngest`);
});
