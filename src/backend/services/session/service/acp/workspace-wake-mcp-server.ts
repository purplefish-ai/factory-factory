/**
 * Workspace wake MCP server.
 *
 * Exposes tools over stdio MCP (JSON-RPC 2.0) that let an agent schedule its
 * OWN workspace to wake up on a cadence, resuming its own session with a
 * stored prompt — distinct from Periodic Tasks, which spawns a fresh
 * workspace per run via the Admin UI.
 *
 * The server reads its workspace context from environment variables set by
 * the ACP runtime manager:
 *   FF_WORKSPACE_ID — the current workspace ID
 *   FF_API_BASE_URL — base URL for the internal tRPC/HTTP API
 *
 * This file is both the MCP server entry point (run as a subprocess) and the
 * module that AcpRuntimeManager imports to obtain the spawn config.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { callTrpcMutation, callTrpcQuery } from './mcp-trpc-client';

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

const PERMISSION_CAVEAT =
  "Note: the woken turn runs under this workspace's existing permission preset. " +
  "If it isn't an auto-approving preset (YOLO), tool-call approval prompts will " +
  'stall with nobody present to answer them — mention this to the user if they ' +
  'want unattended wakes to actually get work done.';

const SET_WAKE_SCHEDULE_TOOL = {
  name: 'set_wake_schedule',
  description:
    'Schedule this workspace to wake itself back up on a cadence, resuming its own ' +
    'session with `prompt` as a new turn (not a fresh workspace). Calling this again ' +
    `replaces any existing schedule for this workspace — there is only one. ${PERMISSION_CAVEAT}`,
  inputSchema: {
    type: 'object',
    properties: {
      cadence: {
        type: 'string',
        enum: ['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'EVERY_HOUR', 'DAILY', 'WEEKLY', 'MONTHLY'],
        description: 'How often to wake up',
      },
      prompt: {
        type: 'string',
        description: "Sent as a new turn to this workspace's own session each time it wakes",
      },
      scheduledTime: {
        type: 'string',
        description: 'HH:MM (24h) time of day to wake, for DAILY/WEEKLY/MONTHLY cadences',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone for scheduledTime (e.g. America/New_York)',
      },
    },
    required: ['cadence', 'prompt'],
  },
};

const GET_WAKE_SCHEDULE_TOOL = {
  name: 'get_wake_schedule',
  description: "Get this workspace's current wake schedule, if any.",
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const CLEAR_WAKE_SCHEDULE_TOOL = {
  name: 'clear_wake_schedule',
  description: "Cancel this workspace's wake schedule, if one is set.",
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ---------------------------------------------------------------------------
// MCP server main loop
// ---------------------------------------------------------------------------

function send(msg: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function errorResult(req: JsonRpcRequest, error: string): void {
  send({
    jsonrpc: '2.0',
    id: req.id,
    result: { content: [{ type: 'text', text: `Error: ${error}` }], isError: true },
  });
}

async function handleSetWakeSchedule(
  req: JsonRpcRequest,
  workspaceId: string,
  args: Record<string, unknown>,
  apiBase: string
): Promise<void> {
  const { result, error } = await callTrpcMutation(apiBase, 'workspaceWake.set', {
    workspaceId,
    cadence: args.cadence,
    prompt: args.prompt,
    scheduledTime: args.scheduledTime,
    timezone: args.timezone,
  });
  if (error) {
    errorResult(req, error);
    return;
  }
  const response = result as
    | { schedule?: { nextWakeAt?: string }; permissionWarning?: string | null }
    | undefined;
  const lines = [`Wake schedule set. Next wake: ${response?.schedule?.nextWakeAt ?? 'unknown'}.`];
  if (response?.permissionWarning) {
    lines.push(`Warning: ${response.permissionWarning} Relay this to the user.`);
  }
  send({
    jsonrpc: '2.0',
    id: req.id,
    result: { content: [{ type: 'text', text: lines.join('\n\n') }] },
  });
}

async function handleGetWakeSchedule(
  req: JsonRpcRequest,
  workspaceId: string,
  apiBase: string
): Promise<void> {
  const { result, error } = await callTrpcQuery(apiBase, 'workspaceWake.get', { workspaceId });
  if (error) {
    errorResult(req, error);
    return;
  }
  const schedule = result as {
    cadence?: string;
    prompt?: string;
    nextWakeAt?: string;
    enabled?: boolean;
  } | null;
  const text = schedule
    ? `Cadence: ${schedule.cadence}, enabled: ${schedule.enabled}, next wake: ${schedule.nextWakeAt}, prompt: ${schedule.prompt}`
    : 'No wake schedule set for this workspace.';
  send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } });
}

async function handleClearWakeSchedule(
  req: JsonRpcRequest,
  workspaceId: string,
  apiBase: string
): Promise<void> {
  const { error } = await callTrpcMutation(apiBase, 'workspaceWake.clear', { workspaceId });
  if (error) {
    errorResult(req, error);
    return;
  }
  send({
    jsonrpc: '2.0',
    id: req.id,
    result: { content: [{ type: 'text', text: 'Wake schedule cleared.' }] },
  });
}

async function dispatchToolCall(
  req: JsonRpcRequest,
  workspaceId: string,
  apiBase: string
): Promise<void> {
  const params = req.params as { name: string; arguments?: Record<string, unknown> };
  const args = params.arguments ?? {};
  if (params.name === 'set_wake_schedule') {
    await handleSetWakeSchedule(req, workspaceId, args, apiBase);
    return;
  }
  if (params.name === 'get_wake_schedule') {
    await handleGetWakeSchedule(req, workspaceId, apiBase);
    return;
  }
  if (params.name === 'clear_wake_schedule') {
    await handleClearWakeSchedule(req, workspaceId, apiBase);
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
  apiBase: string
): Promise<void> {
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'factory-factory-workspace-wake', version: '1.0.0' },
      },
    });
    return;
  }

  if (req.method === 'notifications/initialized') {
    return;
  }

  if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: [SET_WAKE_SCHEDULE_TOOL, GET_WAKE_SCHEDULE_TOOL, CLEAR_WAKE_SCHEDULE_TOOL] },
    });
    return;
  }

  if (req.method === 'tools/call') {
    await dispatchToolCall(req, workspaceId, apiBase);
    return;
  }

  send({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32_601, message: `Method not found: ${req.method}` },
  });
}

// Entry point — only runs when this file is executed directly as a subprocess
if (process.env.FF_WORKSPACE_WAKE_MCP === '1') {
  const workspaceId = process.env.FF_WORKSPACE_ID ?? '';
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
    handleRequest(req, workspaceId, apiBase).catch((err) => {
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

/** Returns the MCP server configuration to pass to newSession/loadSession for a given workspace. */
export function getWorkspaceWakeMcpServerConfig(opts: {
  workspaceId: string;
  apiBaseUrl: string;
}): { name: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    name: 'factory-factory-workspace-wake',
    command: process.execPath, // node
    args: [fileURLToPath(import.meta.url)],
    env: {
      FF_WORKSPACE_WAKE_MCP: '1',
      FF_WORKSPACE_ID: opts.workspaceId,
      FF_API_BASE_URL: opts.apiBaseUrl,
    },
  };
}
