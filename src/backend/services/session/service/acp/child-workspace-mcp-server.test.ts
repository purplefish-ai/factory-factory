import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getChildWorkspaceMcpServerConfig } from './child-workspace-mcp-server';

const toolResponseSchema = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string() })),
    isError: z.boolean().optional(),
  }),
});

type ToolResponse = z.infer<typeof toolResponseSchema>;

type ToolOptions = {
  childWorkspacesEnabled?: boolean;
  body: unknown;
  stallResponse?: boolean;
  linkedWorkspace?: unknown;
  status: number;
  toolName:
    | 'spawn_child_workspace'
    | 'list_projects'
    | 'archive_child_workspace'
    | 'propose_agent'
    | 'list_agent_sources'
    | 'get_agent_proposal'
    | 'get_linear_issue'
    | 'list_mail'
    | 'read_mail'
    | 'ack_mail'
    | 'send_message_to_child'
    | 'send_message_to_parent';
  parentWorkspaceId?: string | null;
  toolArguments?: Record<string, unknown>;
};

async function callToolWithHttpResponse(
  options: ToolOptions,
  timeoutMs = 2000
): Promise<{
  requestBody: unknown;
  requestMethod: string | undefined;
  requestUrl: string | undefined;
  response: ToolResponse;
}> {
  if (activeCall) {
    throw new Error('MCP fixture calls must remain sequential');
  }
  const capture: {
    requestBody: unknown;
    requestMethod: string | undefined;
    requestUrl: string | undefined;
  } = {
    requestBody: undefined,
    requestMethod: undefined,
    requestUrl: undefined,
  };
  activeCall = { options, capture };
  const responseAbort = new AbortController();
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const current = getClient(options.parentWorkspaceId ?? null);
    client = current;
    const id = nextRequestId++;
    const reply = Promise.race([
      once(client.lines, 'line', { signal: responseAbort.signal }),
      client.closed.then(([code]) => {
        throw new Error(
          `MCP process exited before replying to request ${id}: ${code}; ${current.stderr()}`
        );
      }),
    ]);
    client.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
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
    const [line] = await withFixtureDeadline(
      reply,
      timeoutMs,
      `MCP response timed out: ${options.toolName}, request ${id}`
    );
    const response = toolResponseSchema.extend({ id: z.literal(id) }).parse(JSON.parse(line));
    expect(client.stderr()).toBe('');
    return { ...capture, response };
  } catch (error) {
    if (client) {
      await discardClient(client);
    }
    throw error;
  } finally {
    responseAbort.abort();
    activeCall = undefined;
  }
}

// Reuse the actual transport and executable within each immutable launch context.
// HTTP responses and captures are reset per request; tests must stay sequential.
let activeCall:
  | {
      options: ToolOptions;
      capture: {
        requestBody: unknown;
        requestMethod: string | undefined;
        requestUrl: string | undefined;
      };
    }
  | undefined;
let nextRequestId = 1;
const clients = new Map<string | null, ReturnType<typeof createClient>>();
const toolServer = createServer((req, res) => {
  if (!activeCall) {
    res.writeHead(500);
    res.end('No active MCP fixture call');
    return;
  }
  const { options, capture } = activeCall;
  if (req.url?.startsWith('/api/trpc/userSettings.get')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        result: {
          data: { json: { childWorkspacesEnabled: options.childWorkspacesEnabled ?? true } },
        },
      })
    );
    return;
  }
  if (options.linkedWorkspace && req.url?.startsWith('/api/trpc/workspace.get')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { data: { json: options.linkedWorkspace } } }));
    return;
  }
  capture.requestMethod = req.method;
  capture.requestUrl = req.url;
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawBody += chunk;
  });
  req.on('end', () => {
    capture.requestBody = rawBody ? JSON.parse(rawBody) : undefined;
    if (options.stallResponse) {
      return;
    }
    res.writeHead(options.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(options.body));
  });
});

function createClient(parentWorkspaceId: string | null) {
  const address = toolServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected the test HTTP server to listen on a TCP port');
  }
  const config = getChildWorkspaceMcpServerConfig({
    nodeExecPath: process.execPath,
    workspaceId: 'parent-workspace',
    parentWorkspaceId,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  const child = spawn(config.command, config.args, {
    cwd: tmpdir(),
    env: { ...process.env, ...config.env },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const closed = once(child, 'close');
  return { child, lines, closed, stderr: () => stderr };
}

function getClient(parentWorkspaceId: string | null) {
  const existing = clients.get(parentWorkspaceId);
  if (existing) {
    return existing;
  }
  const client = createClient(parentWorkspaceId);
  clients.set(parentWorkspaceId, client);
  return client;
}

beforeAll(async () => {
  toolServer.listen(0, '127.0.0.1');
  await once(toolServer, 'listening');
});

async function withFixtureDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function discardClient(client: ReturnType<typeof createClient>) {
  for (const [context, candidate] of clients) {
    if (candidate === client) {
      clients.delete(context);
    }
  }
  client.lines.close();
  if (client.child.exitCode === null && client.child.signalCode === null) {
    client.child.kill('SIGKILL');
  }
  await withFixtureDeadline(client.closed, 1000, 'MCP process did not close after SIGKILL');
}

async function closeClient(client: ReturnType<typeof createClient>) {
  try {
    client.child.stdin.end();
    const [exitCode] = await withFixtureDeadline(
      client.closed,
      500,
      'MCP graceful shutdown timed out'
    );
    expect(exitCode).toBe(0);
    expect(client.stderr()).toBe('');
  } finally {
    await discardClient(client);
  }
}

afterAll(async () => {
  try {
    const outcomes = await Promise.allSettled([...clients.values()].map(closeClient));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
    }
  } finally {
    const closed = once(toolServer, 'close');
    toolServer.closeAllConnections();
    toolServer.close();
    await withFixtureDeadline(closed, 500, 'MCP fixture HTTP server did not close');
  }
});

describe('child workspace MCP tRPC errors', () => {
  it('rejects child tools when disabled without calling the workspace API', async () => {
    const { response, requestMethod } = await callToolWithHttpResponse({
      childWorkspacesEnabled: false,
      status: 200,
      toolName: 'spawn_child_workspace',
      body: { result: { data: { json: {} } } },
    });
    expect(response.result.isError).toBe(true);
    expect(requestMethod).toBeUndefined();
  });

  it('reports an unlinked Linear issue even when child workspaces are disabled', async () => {
    const { response, requestMethod } = await callToolWithHttpResponse({
      childWorkspacesEnabled: false,
      status: 200,
      toolName: 'get_linear_issue',
      body: {
        result: {
          data: {
            json: {
              id: 'parent-workspace',
              projectId: 'project-1',
              linearIssueId: null,
            },
          },
        },
      },
    });
    expect(requestMethod).toBe('GET');
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe('No Linear issue is linked to this workspace.');
  });

  it('reads the linked Linear issue through backend credentials and omits unrelated data', async () => {
    const { response, requestMethod, requestUrl } = await callToolWithHttpResponse({
      childWorkspacesEnabled: false,
      status: 200,
      toolName: 'get_linear_issue',
      toolArguments: { workspaceId: 'spoofed', projectId: 'other', issueId: 'other' },
      linkedWorkspace: {
        id: 'parent-workspace',
        projectId: 'project-1',
        linearIssueId: 'linear-42',
      },
      body: {
        result: {
          data: {
            json: {
              issue: {
                id: 'linear-42',
                identifier: 'ENG-42',
                title: 'Fix login',
                description: 'Preserve the redirect after login.',
                url: 'https://linear.app/issue/ENG-42',
                state: 'Todo',
                extraPrivateData: 'must not be returned',
              },
              error: null,
            },
          },
        },
      },
    });
    expect(requestMethod).toBe('GET');
    expect(requestUrl).toContain('/api/trpc/linear.getIssue?');
    const input = new URL(`http://localhost${requestUrl}`).searchParams.get('input');
    expect(JSON.parse(input ?? '')).toEqual({
      json: { projectId: 'project-1', issueId: 'linear-42' },
    });
    expect(response.result.isError).not.toBe(true);
    expect(JSON.parse(response.result.content[0]?.text ?? '')).toEqual({
      id: 'linear-42',
      identifier: 'ENG-42',
      title: 'Fix login',
      description: 'Preserve the redirect after login.',
      url: 'https://linear.app/issue/ENG-42',
      state: 'Todo',
    });
  });

  it.each([
    { issue: null, error: 'Provider failure details' },
    { issue: null, error: null },
  ])(
    'reports a Linear integration failure without exposing provider details: %j',
    async (result) => {
      const { response } = await callToolWithHttpResponse({
        childWorkspacesEnabled: false,
        status: 200,
        toolName: 'get_linear_issue',
        linkedWorkspace: {
          id: 'parent-workspace',
          projectId: 'project-1',
          linearIssueId: 'linear-42',
        },
        body: { result: { data: { json: result } } },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0]?.text).toBe(
        'Could not fetch the linked Linear issue. Check the project’s Linear integration.'
      );
    }
  );

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

it.each([
  { parentWorkspaceId: null, enabled: true, settingsFailure: null },
  { parentWorkspaceId: 'parent-workspace', enabled: true, settingsFailure: null },
  { parentWorkspaceId: null, enabled: false, settingsFailure: null },
  { parentWorkspaceId: 'parent-workspace', enabled: false, settingsFailure: null },
  { parentWorkspaceId: null, enabled: false, settingsFailure: 'http' },
  { parentWorkspaceId: null, enabled: false, settingsFailure: 'malformed' },
])(
  'advertises safe tools and rejects recovery controls (parent=$parentWorkspaceId, enabled=$enabled, failure=$settingsFailure)',
  async ({ parentWorkspaceId, enabled, settingsFailure }) => {
    let calls = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/trpc/userSettings.get')) {
        if (settingsFailure) {
          res.statusCode = settingsFailure === 'http' ? 503 : 200;
          res.end(
            JSON.stringify(
              settingsFailure === 'http'
                ? { error: { json: { message: 'Settings unavailable' } } }
                : { result: { data: { json: { childWorkspacesEnabled: 'invalid' } } } }
            )
          );
          return;
        }
        res.end(
          JSON.stringify({ result: { data: { json: { childWorkspacesEnabled: enabled } } } })
        );
        return;
      }
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
        parentWorkspaceId,
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
        'agent.recoveryTarget',
        'recoveryTarget',
        'recovery_target',
        'agent.inspectRun',
        'inspectRun',
        'inspect_agent_run',
        'agent.resolveAmbiguousRun',
        'resolveAmbiguousRun',
        'agent.activate',
        'agent.pause',
        'setEnabled',
      ];
      const messages = [
        JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
        ...(settingsFailure
          ? [
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1000,
                method: 'tools/call',
                params: {
                  name: 'spawn_child_workspace',
                  arguments: { projectId: 'project', name: 'Child' },
                },
              }),
            ]
          : []),
        ...forbidden.flatMap((name, index) =>
          ['RESOLVE', 'ABANDON', 'RETRY'].map((action, actionIndex) =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: index * 3 + actionIndex + 1,
              method: 'tools/call',
              params: {
                name,
                arguments: {
                  projectId: 'project',
                  agentId: 'agent',
                  runId: 'run',
                  claim: {
                    status: 'CLAIMED',
                    runId: 'run',
                    workerGeneration: 1,
                    attemptGeneration: 1,
                    reservedWorkspaceId: 'workspace',
                    reservedSessionId: 'session',
                    initialMessageId: 'original',
                  },
                  attempt: {
                    runId: 'run',
                    sessionId: 'session',
                    messageId: 'current',
                    sendAttemptId: 'send',
                    workerGeneration: 1,
                    attemptGeneration: 1,
                  },
                  action,
                },
              },
            })
          )
        ),
      ].join('\n');
      child.stdin.end(`${messages}\n`);
      expect((await once(child, 'close'))[0]).toBe(0);
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
      expect(names).toEqual([
        ...(!enabled
          ? []
          : parentWorkspaceId
            ? ['send_message_to_parent']
            : [
                'list_projects',
                'spawn_child_workspace',
                'send_message_to_child',
                'archive_child_workspace',
              ]),
        'get_linear_issue',
        'list_mail',
        'read_mail',
        'ack_mail',
        'list_agent_sources',
        'propose_agent',
        'get_agent_proposal',
      ]);
      const recoveryResponses = responses.filter((row) => row.id > 0 && row.id < 1000);
      expect(recoveryResponses).toHaveLength(forbidden.length * 3);
      expect(recoveryResponses.every((row) => row.error?.code === -32_601)).toBe(true);
      if (settingsFailure) {
        expect(responses.find((row) => row.id === 1000)).toMatchObject({
          error: { code: -32_603 },
        });
      }
      expect(calls).toBe(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  }
);

it.each([null, 'root-workspace'])(
  'scopes bounded mail listing to MCP workspace (parent=%s)',
  async (parentWorkspaceId) => {
    const { requestMethod, requestUrl, response } = await callToolWithHttpResponse({
      status: 200,
      parentWorkspaceId,
      toolName: 'list_mail',
      childWorkspacesEnabled: false,
      toolArguments: { workspaceId: 'spoofed-workspace', limit: 2, cursor: 7 },
      body: { result: { data: { json: { items: [], nextCursor: null, revision: 8 } } } },
    });
    expect(requestMethod).toBe('GET');
    const url = new URL(requestUrl!, 'http://localhost');
    expect(url.pathname).toBe('/api/trpc/workspace.listMail');
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({
      json: { workspaceId: 'parent-workspace', limit: 2, cursor: 7, includeSuperseded: false },
    });
    expect(JSON.parse(response.result.content[0]!.text)).toEqual({
      items: [],
      nextCursor: null,
      revision: 8,
      wakeAmbiguous: false,
    });
  }
);

it('reads selected mail through the recipient-scoped bounded endpoint', async () => {
  const { requestMethod, requestBody, response } = await callToolWithHttpResponse({
    status: 200,
    toolName: 'read_mail',
    toolArguments: { workspaceId: 'spoofed', ids: ['mail-1'], offset: 8, maxChars: 256 },
    body: { result: { data: { json: { items: [], revision: 9 } } } },
  });
  expect(requestMethod).toBe('POST');
  expect(requestBody).toEqual({
    json: { workspaceId: 'parent-workspace', ids: ['mail-1'], offset: 8, maxChars: 256 },
  });
  expect(response.result.isError).not.toBe(true);
});

it('acknowledges exact mail IDs at the observed revision', async () => {
  const { requestBody } = await callToolWithHttpResponse({
    status: 200,
    toolName: 'ack_mail',
    toolArguments: { workspaceId: 'spoofed', ids: ['mail-1'], throughRevision: 9 },
    body: { result: { data: { json: { acknowledged: 1, revision: 10 } } } },
  });
  expect(requestBody).toEqual({
    json: { workspaceId: 'parent-workspace', ids: ['mail-1'], throughRevision: 9 },
  });
});

it('describes send acceptance as persisted mail rather than live delivery', async () => {
  const { requestBody, response } = await callToolWithHttpResponse({
    status: 200,
    toolName: 'send_message_to_child',
    toolArguments: {
      childWorkspaceId: 'child-1',
      message: 'Full report',
      subject: 'Ready',
      kind: 'COMPLETION',
      taskKey: 'audit',
      taskRevision: 3,
    },
    body: { result: { data: { json: { delivered: false, persisted: true, queued: true } } } },
  });
  expect(requestBody).toEqual({
    json: {
      parentWorkspaceId: 'parent-workspace',
      childWorkspaceId: 'child-1',
      message: 'Full report',
      subject: 'Ready',
      kind: 'COMPLETION',
      taskKey: 'audit',
      taskRevision: 3,
    },
  });
  expect(response.result.content[0]!.text).toBe('Mail persisted in child workspace inbox.');
});

it('does not claim persisted mail when the backend could not store it', async () => {
  const { response } = await callToolWithHttpResponse({
    status: 200,
    toolName: 'send_message_to_child',
    toolArguments: { childWorkspaceId: 'child-1', message: 'Report' },
    body: { result: { data: { json: { delivered: false } } } },
  });
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0]?.text).toContain('not persisted');
});

it.each(['send_message_to_child', 'send_message_to_parent'] as const)(
  'does not claim persisted mail for an empty backend error from %s',
  async (toolName) => {
    const { response } = await callToolWithHttpResponse({
      status: 200,
      toolName,
      parentWorkspaceId: toolName === 'send_message_to_parent' ? 'parent-workspace' : null,
      toolArguments: { childWorkspaceId: 'child-1', message: 'Report' },
      body: { error: { message: '' } },
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toContain('not persisted');
  }
);

it.each(['send_message_to_child', 'send_message_to_parent'] as const)(
  'returns a tool error without calling the API for invalid metadata in %s',
  async (toolName) => {
    for (const metadata of [{ kind: 'typo' }, { taskRevision: 2_147_483_648 }, { subject: ' ' }]) {
      const { requestUrl, response } = await callToolWithHttpResponse({
        status: 200,
        toolName,
        parentWorkspaceId: toolName === 'send_message_to_parent' ? 'parent-workspace' : null,
        toolArguments: { childWorkspaceId: 'child-1', message: 'Report', ...metadata },
        body: { result: { data: { json: { persisted: true } } } },
      });
      expect(requestUrl).toBeUndefined();
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0]?.text).toContain('Invalid mail metadata');
    }
  }
);

it.each(['send_message_to_child', 'send_message_to_parent'] as const)(
  'forwards the maximum Prisma task revision in %s',
  async (toolName) => {
    const { requestBody, response } = await callToolWithHttpResponse({
      status: 200,
      toolName,
      parentWorkspaceId: toolName === 'send_message_to_parent' ? 'parent-workspace' : null,
      toolArguments: {
        childWorkspaceId: 'child-1',
        message: 'Report',
        taskRevision: 2_147_483_647,
      },
      body: { result: { data: { json: { persisted: true } } } },
    });
    expect(requestBody).toMatchObject({ json: { taskRevision: 2_147_483_647 } });
    expect(response.result.isError).not.toBe(true);
  }
);

it('bounds an unanswered real HTTP call, closes its process, and replaces the client', async () => {
  const client = getClient(null);
  await expect(
    callToolWithHttpResponse(
      { status: 200, toolName: 'list_projects', body: {}, stallResponse: true },
      250
    )
  ).rejects.toThrow('MCP response timed out: list_projects');
  expect(client.child.signalCode).toBe('SIGKILL');
  expect(client.lines.listenerCount('line')).toBe(0);
  expect(activeCall).toBeUndefined();
  expect(clients.has(null)).toBe(false);
  const { response } = await callToolWithHttpResponse({
    status: 200,
    toolName: 'list_projects',
    body: { result: { data: { json: [] } } },
  });
  expect(response.result.isError).not.toBe(true);
  expect(getClient(null)).not.toBe(client);
});

it('bounds graceful shutdown when a real backend call remains pending', async () => {
  const client = getClient(null);
  let notifyRequest: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const observeRequest = (request: IncomingMessage) => {
    if (request.url?.startsWith('/api/trpc/project.list')) notifyRequest();
  };
  toolServer.on('request', observeRequest);
  const pending = callToolWithHttpResponse({
    status: 200,
    toolName: 'list_projects',
    body: {},
    stallResponse: true,
  });
  void pending.catch(() => undefined);
  try {
    await withFixtureDeadline(requested, 1_000, 'Stalled HTTP request was not observed');
    await expect(closeClient(client)).rejects.toThrow('MCP graceful shutdown timed out');
    await expect(pending).rejects.toThrow('MCP process exited before replying');
    expect(client.child.signalCode).toBe('SIGKILL');
    expect(client.lines.listenerCount('line')).toBe(0);
    expect(activeCall).toBeUndefined();
    expect(clients.has(null)).toBe(false);
  } finally {
    toolServer.off('request', observeRequest);
    await discardClient(client);
    await pending.catch(() => undefined);
  }
});
