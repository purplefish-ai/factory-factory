import { z } from 'zod';
import type { ToolEvent } from './types';

const prUrl = z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/);
const prFields = z.object({ url: z.string().optional(), html_url: z.string().optional() });
const envelopeFields = z.object({ result: z.unknown().optional() });
const createTools = new Set([
  'github.create_pull_request',
  'github_create_pull_request',
  'create_pull_request',
]);
const resultFields = z.object({
  structuredContent: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
});
const textBlock = z.object({ type: z.literal('text'), text: z.string() });

function decode(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}

function canonicalUrl(value: unknown): string | null {
  const decoded = decode(value);
  const fields = prFields.safeParse(decoded);
  return fields.success
    ? (prUrl.safeParse(fields.data.html_url).data ?? prUrl.safeParse(fields.data.url).data ?? null)
    : (prUrl.safeParse(decoded).data ?? null);
}

function readResult(value: unknown): string | null {
  const decoded = decode(value);
  const envelope = envelopeFields.safeParse(decoded);
  const payload = envelope.data?.result ?? decoded;
  const result = resultFields.safeParse(payload);
  if (result.data?.isError) {
    return null;
  }
  if (result.data?.structuredContent != null) {
    return canonicalUrl(result.data.structuredContent);
  }
  const blocks = result.data?.content ?? (Array.isArray(payload) ? payload : []);
  for (const block of blocks) {
    const url = canonicalUrl(textBlock.safeParse(block).data?.text);
    if (url) {
      return url;
    }
  }
  return canonicalUrl(payload);
}

export function getGithubMcpCreatedPrUrl(event: ToolEvent): string | null {
  const display = /^(?:mcpToolCall:([^/]+)\/|mcp\.([^.]+)\.)(.+)$/.exec(event.toolName);
  const server = event.input.server ?? display?.[1] ?? display?.[2];
  const tool = event.input.tool ?? display?.[3] ?? event.toolName;
  const official =
    typeof server === 'string' && ['github', 'codex_apps'].includes(server.toLowerCase());
  const legacy = server === undefined && tool === 'github_create_pull_request';
  const recognized = legacy || (official && typeof tool === 'string' && createTools.has(tool));
  if (event.output?.isError || !recognized) {
    return null;
  }
  return (
    readResult(event.input.rawOutput) ??
    readResult(event.input.aggregatedOutput) ??
    readResult(event.output?.content)
  );
}
