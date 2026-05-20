import type { McpServer, PromptRequest } from '@agentclientprotocol/sdk';
import { dedupeStrings, isRecord } from './acp-adapter-utils';
import type { CodexMcpServerConfig } from './adapter-state';

type PromptContentBlock = PromptRequest['prompt'][number];

export function isPlanLikeMode(mode: string): boolean {
  return /plan/i.test(mode);
}

const PLAN_TEXT_MAX_DEPTH = 8;
const PLAN_TEXT_PREFERRED_KEYS = [
  'plan',
  'text',
  'content',
  'markdown',
  'value',
  'message',
] as const;
const REASONING_TEXT_MAX_DEPTH = 8;
const REASONING_TEXT_PREFERRED_KEYS = [
  'summary',
  'summaryText',
  'text',
  'delta',
  'message',
  'content',
  'reasoning',
] as const;

function extractFirstPlanText(values: Iterable<unknown>, depth: number): string | null {
  for (const entry of values) {
    const extracted = extractPlanText(entry, depth + 1);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function extractPlanTextFromRecord(value: Record<string, unknown>, depth: number): string | null {
  const preferred = extractFirstPlanText(
    PLAN_TEXT_PREFERRED_KEYS.map((key) => value[key]),
    depth
  );
  if (preferred) {
    return preferred;
  }
  return extractFirstPlanText(Object.values(value), depth);
}

export function extractPlanText(value: unknown, depth = 0): string | null {
  if (depth > PLAN_TEXT_MAX_DEPTH) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }

  if (Array.isArray(value)) {
    return extractFirstPlanText(value, depth);
  }

  if (!isRecord(value)) {
    return null;
  }

  return extractPlanTextFromRecord(value, depth);
}

function collectReasoningText(values: string[], value: unknown, depth = 0): void {
  if (depth > REASONING_TEXT_MAX_DEPTH) {
    return;
  }

  if (typeof value === 'string') {
    if (value.trim().length > 0) {
      values.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReasoningText(values, entry, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of REASONING_TEXT_PREFERRED_KEYS) {
    collectReasoningText(values, value[key], depth + 1);
  }
}

export function extractReasoningText(value: unknown): string | null {
  const collected: string[] = [];
  collectReasoningText(collected, value);
  if (collected.length === 0) {
    return null;
  }

  return dedupeStrings(collected).join('\n\n');
}

function toMcpEnvRecord(envVars: Array<{ name: string; value: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envVars) {
    env[entry.name] = entry.value;
  }
  return env;
}

function toMcpHeadersRecord(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    result[header.name] = header.value;
  }
  return result;
}

function sanitizeMcpServerName(name: string, index: number): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : `mcp_server_${index + 1}`;
}

function toCodexMcpServerConfig(server: McpServer): CodexMcpServerConfig {
  if ('command' in server) {
    const env = toMcpEnvRecord(server.env);
    return {
      enabled: true,
      command: server.command,
      args: [...server.args],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const httpHeaders = toMcpHeadersRecord(server.headers);
  return {
    enabled: true,
    url: server.url,
    ...(Object.keys(httpHeaders).length > 0 ? { http_headers: httpHeaders } : {}),
    ...(server.type === 'sse' ? { transport: 'sse' as const } : {}),
  };
}

export function toCodexMcpConfigMap(mcpServers: McpServer[]): Record<string, CodexMcpServerConfig> {
  const mcpServersByName: Record<string, CodexMcpServerConfig> = {};
  const usedNames = new Set<string>();

  for (const [index, server] of mcpServers.entries()) {
    const baseName = sanitizeMcpServerName(server.name, index);
    let nextName = baseName;
    let suffix = 2;
    while (usedNames.has(nextName)) {
      nextName = `${baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(nextName);
    mcpServersByName[nextName] = toCodexMcpServerConfig(server);
  }

  return mcpServersByName;
}

export function parseTextFromPromptBlock(block: PromptContentBlock): string {
  if (block.type === 'text') {
    return block.text;
  }

  if (block.type === 'resource_link') {
    return `[ACP_RESOURCE_LINK uri="${block.uri}" name="${block.name}"]\n[/ACP_RESOURCE_LINK]`;
  }

  if (block.type === 'resource') {
    const resource = block.resource;
    const mime = resource.mimeType ?? 'unknown';
    const payload =
      'text' in resource && typeof resource.text === 'string'
        ? resource.text
        : 'blob' in resource && typeof resource.blob === 'string'
          ? resource.blob
          : JSON.stringify(resource);
    return `[ACP_RESOURCE uri="${resource.uri}" mime="${mime}"]\n${payload}\n[/ACP_RESOURCE]`;
  }

  if (block.type === 'image') {
    const mime = block.mimeType ?? 'application/octet-stream';
    return `[ACP_IMAGE mime="${mime}" bytes=${block.data.length}]`;
  }

  return JSON.stringify(block);
}
