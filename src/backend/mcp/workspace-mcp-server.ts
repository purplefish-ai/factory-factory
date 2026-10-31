/**
 * Child workspace MCP server.
 *
 * Exposes tools over stdio MCP (JSON-RPC 2.0):
 *   Parent workspaces: spawn_child_workspace, list_projects,
 *                      send_message_to_child, archive_child_workspace
 *   Child workspaces:  send_message_to_parent
 *
 * The runtime passes workspace context as a JSON command-line argument.
 * This entry point validates it before starting the stdio MCP loop.
 *
 * The session runtime injects the spawn configuration; application tool
 * implementations live here, outside ACP internals.
 */

import { createInterface } from 'node:readline';
import { z } from 'zod';
import { AGENT_AUTHORING_TOOLS, callAgentAuthoringTool } from './agent-authoring-tools';

// ---------------------------------------------------------------------------
// Types (minimal MCP protocol subset)
// ---------------------------------------------------------------------------

const requestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
type JsonRpcRequest = z.infer<typeof requestSchema>;
const toolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const trpcResponseSchema = z.object({
  result: z.object({ data: z.object({ json: z.unknown() }).optional() }).optional(),
  error: z
    .object({
      message: z.string().optional(),
      json: z.object({ message: z.string().optional() }).optional(),
    })
    .optional(),
});

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SPAWN_TOOL = {
  name: 'spawn_child_workspace',
  description:
    'Create a child workspace to handle a sub-task, optionally in a different project. ' +
    'Requires user confirmation — use for substantial, longer-running work only.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'ID of the project to create the workspace in' },
      name: { type: 'string', description: 'Name for the child workspace' },
      description: { type: 'string', description: 'Optional description' },
      initialPrompt: { type: 'string', description: 'Starting prompt for the child session' },
      reportBackOn: {
        type: 'string',
        description: 'Describe when the child should report back (e.g. "when a PR is opened")',
      },
    },
    required: ['projectId', 'name'],
  },
};

const SEND_MSG_TOOL = {
  name: 'send_message_to_parent',
  description:
    "Send a status update or result back to the parent workspace's active agent session.",
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to send (plain text or markdown)' },
    },
    required: ['message'],
  },
};

const SEND_MSG_TO_CHILD_TOOL = {
  name: 'send_message_to_child',
  description:
    "Send a message or instruction to a child workspace's active agent session. Use this to give a running child workspace new instructions, answer its questions, or direct it to change course.",
  inputSchema: {
    type: 'object',
    properties: {
      childWorkspaceId: { type: 'string', description: 'ID of the child workspace' },
      message: { type: 'string', description: 'Message to send' },
    },
    required: ['childWorkspaceId', 'message'],
  },
};

const ARCHIVE_CHILD_TOOL = {
  name: 'archive_child_workspace',
  description:
    'Archive a child workspace when it has completed its task (e.g. PR is merged). This stops the child workspace and cleans up its resources.',
  inputSchema: {
    type: 'object',
    properties: {
      childWorkspaceId: { type: 'string', description: 'ID of the child workspace to archive' },
      removeGitIndexLock: {
        type: 'boolean',
        description:
          'Remove the child worktree Git index lock before retrying archive. Set true only after explicit user confirmation in response to a Git lock error.',
      },
    },
    required: ['childWorkspaceId'],
  },
};

const LIST_PROJECTS_TOOL = {
  name: 'list_projects',
  description:
    'List all available projects. Use this to discover project IDs before calling spawn_child_workspace.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ---------------------------------------------------------------------------
// HTTP helper — calls the internal tRPC HTTP API via a simple POST
// ---------------------------------------------------------------------------

async function callTrpcMutation(
  baseUrl: string,
  path: string,
  input: unknown
): Promise<{ result?: unknown; error?: string }> {
  const url = `${baseUrl}/api/trpc/${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: input }),
    });
    const body = trpcResponseSchema.parse(await res.json());
    if (!res.ok || body.error) {
      return { error: body.error?.json?.message ?? body.error?.message ?? `HTTP ${res.status}` };
    }
    return { result: body.result?.data?.json };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function callTrpcQuery(
  baseUrl: string,
  path: string,
  input?: unknown
): Promise<{ result?: unknown; error?: string }> {
  const inputParam =
    input !== undefined ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}` : '';
  const url = `${baseUrl}/api/trpc/${path}${inputParam}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    const body = trpcResponseSchema.parse(await res.json());
    if (!res.ok || body.error) {
      return { error: body.error?.json?.message ?? body.error?.message ?? `HTTP ${res.status}` };
    }
    return { result: body.result?.data?.json };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// MCP server main loop
// ---------------------------------------------------------------------------

function send(msg: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleSpawnTool(
  req: JsonRpcRequest,
  workspaceId: string,
  args: Record<string, unknown>,
  apiBase: string
): Promise<void> {
  const { result, error } = await callTrpcMutation(apiBase, 'workspace.createChild', {
    parentWorkspaceId: workspaceId,
    projectId: args.projectId,
    name: args.name,
    description: args.description,
    initialPrompt: args.initialPrompt,
    reportBackOn: args.reportBackOn,
  });
  if (error) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `Error: ${error}` }], isError: true },
    });
  } else {
    const r = result as { workspaceId?: string };
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [
          {
            type: 'text',
            text: `Child workspace created successfully. Workspace ID: ${r?.workspaceId ?? 'unknown'}`,
          },
        ],
      },
    });
  }
}

async function handleSendMsgTool(
  req: JsonRpcRequest,
  workspaceId: string,
  args: Record<string, unknown>,
  apiBase: string
): Promise<void> {
  const { error } = await callTrpcMutation(apiBase, 'workspace.sendMessageToParent', {
    childWorkspaceId: workspaceId,
    message: args.message,
  });
  if (error) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `Error: ${error}` }], isError: true },
    });
  } else {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: 'Message sent to parent workspace.' }] },
    });
  }
}

async function handleSendMsgToChildTool(
  req: JsonRpcRequest,
  workspaceId: string,
  args: Record<string, unknown>,
  apiBase: string
): Promise<void> {
  const { result, error } = await callTrpcMutation(apiBase, 'workspace.sendMessageToChild', {
    parentWorkspaceId: workspaceId,
    childWorkspaceId: args.childWorkspaceId,
    message: args.message,
  });
  if (error) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `Error: ${error}` }], isError: true },
    });
  } else {
    const r = result as { delivered?: boolean };
    const status = r?.delivered ? 'delivered live' : 'queued for next session start';
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `Message sent to child workspace (${status}).` }] },
    });
  }
}

async function handleArchiveChildTool(
  req: JsonRpcRequest,
  workspaceId: string,
  args: Record<string, unknown>,
  apiBase: string
): Promise<void> {
  const { error } = await callTrpcMutation(apiBase, 'workspace.archiveChild', {
    parentWorkspaceId: workspaceId,
    childWorkspaceId: args.childWorkspaceId,
    ...(args.removeGitIndexLock === true ? { removeGitIndexLock: true } : {}),
  });
  if (error) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `Error: ${error}` }], isError: true },
    });
  } else {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: 'Child workspace archived successfully.' }] },
    });
  }
}

async function handleListProjectsTool(req: JsonRpcRequest, apiBase: string): Promise<void> {
  const { result, error } = await callTrpcQuery(apiBase, 'project.list');
  if (error) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `Error: ${error}` }], isError: true },
    });
    return;
  }
  const projects = result as Array<{ id: string; name: string; slug: string }> | undefined;
  const text =
    projects && projects.length > 0
      ? projects.map((p) => `- ${p.name} (id: ${p.id}, slug: ${p.slug})`).join('\n')
      : 'No projects found.';
  send({
    jsonrpc: '2.0',
    id: req.id,
    result: { content: [{ type: 'text', text }] },
  });
}

async function dispatchToolCall(
  req: JsonRpcRequest,
  workspaceId: string,
  hasParent: boolean,
  apiBase: string
): Promise<void> {
  const params = toolCallSchema.parse(req.params);
  const args = params.arguments;
  if (AGENT_AUTHORING_TOOLS.some((tool) => tool.name === params.name)) {
    const result = await callAgentAuthoringTool({
      name: params.name,
      args,
      workspaceId,
      apiBase,
      query: callTrpcQuery,
      mutate: callTrpcMutation,
    });
    send({ jsonrpc: '2.0', id: req.id, result });
    return;
  }
  if (params.name === 'spawn_child_workspace' && !hasParent) {
    await handleSpawnTool(req, workspaceId, args, apiBase);
    return;
  }
  if (params.name === 'list_projects' && !hasParent) {
    await handleListProjectsTool(req, apiBase);
    return;
  }
  if (params.name === 'send_message_to_parent' && hasParent) {
    await handleSendMsgTool(req, workspaceId, args, apiBase);
    return;
  }
  if (params.name === 'send_message_to_child' && !hasParent) {
    await handleSendMsgToChildTool(req, workspaceId, args, apiBase);
    return;
  }
  if (params.name === 'archive_child_workspace' && !hasParent) {
    await handleArchiveChildTool(req, workspaceId, args, apiBase);
    return;
  }
  send({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32_601, message: `Unknown tool: ${params.name}` },
  });
}

async function handleRequest(
  req: JsonRpcRequest,
  workspaceId: string,
  parentId: string,
  apiBase: string
): Promise<void> {
  const hasParent = parentId.length > 0;

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'factory-factory-child-workspace', version: '1.0.0' },
      },
    });
    return;
  }

  if (req.method === 'notifications/initialized') {
    return;
  }

  if (req.method === 'tools/list') {
    const workspaceTools = hasParent
      ? [SEND_MSG_TOOL]
      : [LIST_PROJECTS_TOOL, SPAWN_TOOL, SEND_MSG_TO_CHILD_TOOL, ARCHIVE_CHILD_TOOL];
    const tools = [...workspaceTools, ...AGENT_AUTHORING_TOOLS];
    send({ jsonrpc: '2.0', id: req.id, result: { tools } });
    return;
  }

  if (req.method === 'tools/call') {
    await dispatchToolCall(req, workspaceId, hasParent, apiBase);
    return;
  }

  send({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32_601, message: `Method not found: ${req.method}` },
  });
}

// Standalone entry point. Context is passed as a validated command-line argument.
{
  const { workspaceId, parentId, apiBase } = z
    .strictObject({
      workspaceId: z.string().min(1),
      parentId: z.string(),
      apiBase: z.url(),
    })
    .parse(JSON.parse(process.argv[2] ?? '{}'));

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let req: JsonRpcRequest;
    try {
      req = requestSchema.parse(JSON.parse(line));
    } catch {
      return;
    }
    // Notifications have no id — skip
    if (req.id === undefined || req.id === null) {
      return;
    }
    handleRequest(req, workspaceId, parentId, apiBase).catch((err) => {
      send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32_603, message: err instanceof Error ? err.message : String(err) },
      });
    });
  });
}
