import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const toolResponseSchema = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string() })),
    isError: z.boolean().optional(),
  }),
});

type ToolResponse = z.infer<typeof toolResponseSchema>;

async function callToolWithHttpResponse(options: {
  body: unknown;
  status: number;
  toolName: 'spawn_child_workspace' | 'list_projects';
}): Promise<{ requestMethod: string | undefined; response: ToolResponse }> {
  let requestMethod: string | undefined;
  const server = createServer((req, res) => {
    requestMethod = req.method;
    res.writeHead(options.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(options.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the test HTTP server to listen on a TCP port');
    }
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./child-workspace-mcp-server.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          FF_CHILD_WORKSPACE_MCP: '1',
          FF_WORKSPACE_ID: 'parent-workspace',
          FF_WORKSPACE_PARENT_ID: '',
          FF_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: options.toolName,
          arguments:
            options.toolName === 'spawn_child_workspace'
              ? { projectId: 'missing-project', name: 'Child workspace' }
              : {},
        },
      })}\n`
    );

    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    return { requestMethod, response: toolResponseSchema.parse(JSON.parse(stdout.trim())) };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('child workspace MCP tRPC errors', () => {
  it('surfaces nested superjson mutation errors before legacy messages', async () => {
    const { requestMethod, response } = await callToolWithHttpResponse({
      status: 404,
      toolName: 'spawn_child_workspace',
      body: {
        error: {
          message: 'Legacy project error',
          json: {
            message: 'Project not found: missing-project',
            code: -32_004,
            data: { code: 'NOT_FOUND', httpStatus: 404 },
          },
        },
      },
    });

    expect(requestMethod).toBe('POST');
    expect(response.result).toEqual({
      content: [{ type: 'text', text: 'Error: Project not found: missing-project' }],
      isError: true,
    });
  });

  it('surfaces nested superjson query errors', async () => {
    const { requestMethod, response } = await callToolWithHttpResponse({
      status: 500,
      toolName: 'list_projects',
      body: { error: { json: { message: 'Unable to list projects' } } },
    });

    expect(requestMethod).toBe('GET');
    expect(response.result.content[0]?.text).toBe('Error: Unable to list projects');
    expect(response.result.isError).toBe(true);
  });

  it('falls back to a legacy top-level tRPC error message', async () => {
    const { response } = await callToolWithHttpResponse({
      status: 400,
      toolName: 'spawn_child_workspace',
      body: { error: { message: 'Legacy validation error' } },
    });

    expect(response.result.content[0]?.text).toBe('Error: Legacy validation error');
  });

  it('falls back to the HTTP status when tRPC omits an error message', async () => {
    const { response } = await callToolWithHttpResponse({
      status: 503,
      toolName: 'list_projects',
      body: { error: { json: {} } },
    });

    expect(response.result.content[0]?.text).toBe('Error: HTTP 503');
  });
});
