import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getChildWorkspaceMcpServerConfig } from './child-workspace-mcp-server';

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
  toolName:
    | 'spawn_child_workspace'
    | 'list_projects'
    | 'archive_child_workspace'
    | 'propose_agent'
    | 'list_agent_sources'
    | 'get_agent_proposal';
  toolArguments?: Record<string, unknown>;
}): Promise<{
  requestBody: unknown;
  requestMethod: string | undefined;
  response: ToolResponse;
}> {
  let requestMethod: string | undefined;
  let requestBody: unknown;
  const server = createServer((req, res) => {
    requestMethod = req.method;
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      requestBody = rawBody ? JSON.parse(rawBody) : undefined;
      res.writeHead(options.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(options.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the test HTTP server to listen on a TCP port');
    }
    const config = getChildWorkspaceMcpServerConfig({
      nodeExecPath: process.execPath,
      workspaceId: 'parent-workspace',
      parentWorkspaceId: null,
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const child = spawn(config.command, config.args, {
      cwd: tmpdir(),
      env: {
        ...process.env,
        ...config.env,
      },
    });
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
            options.toolArguments ??
            (options.toolName === 'spawn_child_workspace'
              ? { projectId: 'missing-project', name: 'Child workspace' }
              : {}),
        },
      })}\n`
    );

    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    return {
      requestBody,
      requestMethod,
      response: toolResponseSchema.parse(JSON.parse(stdout.trim())),
    };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('child workspace MCP tRPC errors', () => {
  it('binds proposals to the current workspace and returns a renderable reference', async () => {
    const { requestBody, response } = await callToolWithHttpResponse({
      status: 200,
      toolName: 'propose_agent',
      toolArguments: {
        workspaceId: 'spoofed',
        specification: {
          name: 'QA reviewer',
          instructions: 'Compare QA edits.',
          triggers: [
            { type: 'SCHEDULE', description: 'Daily QA', config: { version: 1, cadence: 'DAILY' } },
          ],
        },
      },
      body: {
        result: {
          data: {
            json: {
              id: 'proposal-1',
              workspaceId: 'parent-workspace',
              revision: 1,
              agentDefinitionId: null,
              sourceNames: {},
              specification: {
                name: 'QA reviewer',
                instructions: 'Compare QA edits.',
                triggers: [
                  {
                    type: 'SCHEDULE',
                    description: 'Daily QA',
                    config: { version: 1, cadence: 'DAILY' },
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(requestBody).toMatchObject({
      json: { workspaceId: 'parent-workspace', specification: { name: 'QA reviewer' } },
    });
    expect(JSON.parse(response.result.content[0]?.text ?? '')).toMatchObject({
      type: 'agent_proposal',
      proposalId: 'proposal-1',
      workspaceId: 'parent-workspace',
      revision: 1,
    });
  });
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

  it('passes explicit Git index-lock recovery for child archive', async () => {
    const { requestBody, response } = await callToolWithHttpResponse({
      status: 200,
      toolName: 'archive_child_workspace',
      toolArguments: {
        childWorkspaceId: 'child-1',
        removeGitIndexLock: true,
      },
      body: { result: { data: { json: { archived: true } } } },
    });

    expect(requestBody).toEqual({
      json: {
        parentWorkspaceId: 'parent-workspace',
        childWorkspaceId: 'child-1',
        removeGitIndexLock: true,
      },
    });
    expect(response.result.content[0]?.text).toBe('Child workspace archived successfully.');
  });
});

it('advertises only existing agent authoring tools and rejects management/activation/recovery calls', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing fixture port');
    }
    const config = getChildWorkspaceMcpServerConfig({
      nodeExecPath: process.execPath,
      workspaceId: 'author',
      parentWorkspaceId: null,
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const child = spawn(config.command, config.args, {
      cwd: tmpdir(),
      env: { ...process.env, ...config.env },
    });
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
    const forbidden = [
      'agent.updateSaved',
      'update_saved_agent',
      'agent.setEnabled',
      'activate_agent',
      'resolve_agent_run',
      'agent.recover',
    ];
    const messages = [
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
      ...forbidden.map((name, index) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name, arguments: {} },
        })
      ),
    ].join('\n');
    child.stdin.end(`${messages}\n`);
    expect((await once(child, 'exit'))[0]).toBe(0);
    expect(stderr).toBe('');
    const responses = stdout
      .trim()
      .split('\n')
      .map((line) =>
        z
          .object({
            id: z.number(),
            result: z.object({ tools: z.array(z.object({ name: z.string() })) }).optional(),
            error: z.object({ code: z.number(), message: z.string() }).optional(),
          })
          .parse(JSON.parse(line))
      );
    const names = responses.find((row) => row.id === 0)!.result!.tools.map((tool) => tool.name);
    expect(names.filter((name) => name.includes('agent'))).toEqual([
      'list_agent_sources',
      'propose_agent',
      'get_agent_proposal',
    ]);
    expect(responses.filter((row) => row.id !== 0)).toHaveLength(forbidden.length);
    expect(
      responses.filter((row) => row.id !== 0).every((row) => row.error?.code === -32_601)
    ).toBe(true);
    expect(calls).toBe(0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
