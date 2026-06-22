/**
 * Child workspace MCP server.
 *
 * Exposes two tools over stdio MCP (JSON-RPC 2.0):
 *   - spawn_child_workspace  — available when FF_WORKSPACE_PARENT_ID is NOT set
 *   - send_message_to_parent — available when FF_WORKSPACE_PARENT_ID IS set
 *
 * The server reads its workspace context from environment variables set by the
 * ACP runtime manager:
 *   FF_WORKSPACE_ID        — the current workspace ID
 *   FF_WORKSPACE_PARENT_ID — the parent workspace ID (empty string = no parent)
 *   FF_API_BASE_URL        — base URL for the internal tRPC/HTTP API
 *
 * This file is both the MCP server entry point (run as a subprocess) and the
 * module that AcpRuntimeManager imports to obtain the spawn config.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types (minimal MCP protocol subset)
// ---------------------------------------------------------------------------

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
};

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
    },
    required: ['childWorkspaceId'],
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
    const body = (await res.json()) as {
      result?: { data?: { json?: unknown } };
      error?: { message?: string };
    };
    if (!res.ok || body.error) {
      return { error: body.error?.message ?? `HTTP ${res.status}` };
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

async function dispatchToolCall(
  req: JsonRpcRequest,
  workspaceId: string,
  hasParent: boolean,
  apiBase: string
): Promise<void> {
  const params = req.params as { name: string; arguments?: Record<string, unknown> };
  const args = params.arguments ?? {};
  if (params.name === 'spawn_child_workspace' && !hasParent) {
    await handleSpawnTool(req, workspaceId, args, apiBase);
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
    const tools = hasParent
      ? [SEND_MSG_TOOL]
      : [SPAWN_TOOL, SEND_MSG_TO_CHILD_TOOL, ARCHIVE_CHILD_TOOL];
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

// Entry point — only runs when this file is executed directly as a subprocess
if (process.env.FF_CHILD_WORKSPACE_MCP === '1') {
  const workspaceId = process.env.FF_WORKSPACE_ID ?? '';
  const parentId = process.env.FF_WORKSPACE_PARENT_ID ?? '';
  const apiBase = process.env.FF_API_BASE_URL ?? 'http://localhost:4000';

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let req: JsonRpcRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      req = parsed as JsonRpcRequest;
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

// ---------------------------------------------------------------------------
// Export: spawn configuration for AcpRuntimeManager
// ---------------------------------------------------------------------------

/**
 * Returns the MCP server configuration to pass to newSession/loadSession for a
 * given workspace, or null if the feature is disabled (no FF_API_BASE_URL set).
 */
export function getChildWorkspaceMcpServerConfig(opts: {
  workspaceId: string;
  parentWorkspaceId: string | null;
  apiBaseUrl: string;
}): { name: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    name: 'factory-factory-child-workspace',
    command: process.execPath, // node
    args: [fileURLToPath(import.meta.url)],
    env: {
      FF_CHILD_WORKSPACE_MCP: '1',
      FF_WORKSPACE_ID: opts.workspaceId,
      FF_WORKSPACE_PARENT_ID: opts.parentWorkspaceId ?? '',
      FF_API_BASE_URL: opts.apiBaseUrl,
    },
  };
}
