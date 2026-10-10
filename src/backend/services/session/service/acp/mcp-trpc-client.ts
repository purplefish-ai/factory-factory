/**
 * Shared internal-tRPC-over-HTTP helpers for MCP server subprocesses
 * (`child-workspace-mcp-server.ts`, `workspace-wake-mcp-server.ts`). Each
 * server runs as a standalone subprocess with no access to the backend's
 * in-process tRPC caller, so it calls back into its own server over HTTP.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export async function callTrpcMutation(
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json()) as {
      result?: { data?: { json?: unknown } };
      error?: { json?: { message?: string }; message?: string };
    };
    if (!res.ok || body.error) {
      return { error: body.error?.json?.message ?? body.error?.message ?? `HTTP ${res.status}` };
    }
    return { result: body.result?.data?.json };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function callTrpcQuery(
  baseUrl: string,
  path: string,
  input?: unknown
): Promise<{ result?: unknown; error?: string }> {
  const inputParam =
    input !== undefined ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}` : '';
  const url = `${baseUrl}/api/trpc/${path}${inputParam}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json()) as {
      result?: { data?: { json?: unknown } };
      error?: { json?: { message?: string }; message?: string };
    };
    if (!res.ok || body.error) {
      return { error: body.error?.json?.message ?? body.error?.message ?? `HTTP ${res.status}` };
    }
    return { result: body.result?.data?.json };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
