import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import chalk from 'chalk';
import {
  FORWARDED_CLIENT_ADDRESS_HEADERS,
  forwardHttpRequest,
  removeHopByHopHeaders,
} from '@/shared/proxy-utils';
import { type ListeningLocalProxy, listenLocalProxy, PROXY_LOCAL_HOST } from './proxy-listen';

/**
 * Methods a public tunnel forwards. tRPC (v11) only runs queries for GET and
 * answers HEAD without running anything; mutations need POST, and its method
 * override only lets POST run queries. Everything else the backend serves over
 * GET is static or a health check. Queries with side effects are refused by
 * name below.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

const READ_ONLY_MESSAGE =
  'This Factory Factory tunnel is public and read-only. Run `ff proxy` without --public to share full access behind a password.';

/**
 * Queries a public tunnel still refuses. Each one either starts a process
 * (agent runtimes, provider CLIs) or reads beyond this instance's own data:
 * any repository the host's `gh` token can see, arbitrary filesystem paths,
 * the host's overall load, server logs, or a full database export.
 */
export const PUBLIC_BLOCKED_PROCEDURES: ReadonlySet<string> = new Set([
  // Start an agent runtime or provider CLI processes.
  'session.listSubagents',
  'session.readSubagentTranscript',
  'userSettings.getProviderOptions',
  'admin.checkCLIHealth',
  // Read through the host's GitHub credentials for any repository.
  'github.getIssuePreview',
  'github.getPRPreview',
  'prReview.getPRDetails',
  'prReview.getDiff',
  'search.githubIssues',
  // Probe or read arbitrary host paths.
  'project.validateRepoPath',
  'project.checkFactoryConfig',
  // Whole-machine load and the processes behind it, which reflect activity
  // outside this instance.
  'admin.getHostMetrics',
  'admin.getHostLoadBreakdown',
  // Logs and a full database export.
  'admin.getLogs',
  'admin.downloadLogFile',
  'admin.exportData',
]);

interface ReadOnlyRejection {
  status: number;
  allow?: string;
}

/**
 * The procedures a request would call, derived exactly as the tRPC Express
 * adapter does: the last path segment, URL-decoded, split on batch commas.
 * Applied to every path, so no mount-path spelling (case, extra segments,
 * encoded dots) avoids it. `null` means the segment cannot be decoded.
 */
function getRequestedProcedures(upstreamPath: string): string[] | null {
  const pathname = upstreamPath.split('?')[0] ?? '';
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(lastSegment).split(',');
  } catch {
    return null;
  }
}

function getReadOnlyRejection(
  req: IncomingMessage,
  upstreamPath: string
): ReadOnlyRejection | null {
  if (!READ_ONLY_METHODS.has(req.method ?? '')) {
    return { status: 405, allow: 'GET, HEAD' };
  }
  // Node emits `request` for upgrade requests when it has no `upgrade`
  // listener; refuse them here too rather than relying on that listener.
  if (req.headers.upgrade !== undefined) {
    return { status: 403 };
  }
  // GET input travels in the query string. A body would only be parsed and
  // ignored, so refusing it keeps a GET from smuggling one upstream.
  const contentLength = req.headers['content-length'];
  if (
    req.headers['transfer-encoding'] !== undefined ||
    (contentLength !== undefined && contentLength !== '0')
  ) {
    return { status: 400 };
  }
  const procedures = getRequestedProcedures(upstreamPath);
  if (procedures === null) {
    return { status: 400 };
  }
  if (procedures.some((procedure) => PUBLIC_BLOCKED_PROCEDURES.has(procedure))) {
    return { status: 403 };
  }
  return null;
}

function writeReadOnlyRejection(res: ServerResponse, rejection: ReadOnlyRejection): void {
  res.statusCode = rejection.status;
  if (rejection.allow) {
    res.setHeader('Allow', rejection.allow);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // The request body, if any, is never read; do not reuse the connection.
  res.setHeader('Connection', 'close');
  res.end(READ_ONLY_MESSAGE);
}

function rejectUpgrade(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

/**
 * Headers for a public request. Client-address headers added by cloudflared
 * are kept, and one is added when missing, so the backend always treats the
 * request as remote and refuses trusted-local procedures even if a request
 * slipped past the method check.
 */
function buildReadOnlyProxyHeaders(
  req: IncomingMessage
): Record<string, string | string[] | undefined> {
  const headers = removeHopByHopHeaders(req.headers);
  const hasClientAddressHeader = FORWARDED_CLIENT_ADDRESS_HEADERS.some(
    (header) => req.headers[header] !== undefined
  );
  if (!hasClientAddressHeader) {
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? 'unknown';
  }
  return headers;
}

function toUpstreamPath(rawUrl: string | undefined): string {
  if (!rawUrl?.startsWith('/')) {
    return '/';
  }
  const parsed = URL.parse(rawUrl, 'http://proxy.local');
  return parsed ? `${parsed.pathname}${parsed.search}` : '/';
}

/**
 * The proxy behind `ff proxy --public`. Without a password it is the only
 * thing between the internet and the backend, and backend procedures that
 * Docker and other deployments call remotely without an `Origin` (including
 * starting agent sessions) would otherwise accept tunnel requests. So it
 * forwards only bodiless GET and HEAD requests and refuses every WebSocket
 * upgrade, whatever headers the client sends.
 */
export function createReadOnlyProxy(params: {
  upstreamPort: number;
}): Promise<ListeningLocalProxy> {
  const server = createServer((req, res) => {
    const upstreamPath = toUpstreamPath(req.url);
    const rejection = getReadOnlyRejection(req, upstreamPath);
    if (rejection) {
      writeReadOnlyRejection(res, rejection);
      return;
    }

    try {
      forwardHttpRequest({
        req,
        res,
        upstreamPort: params.upstreamPort,
        path: upstreamPath,
        headers: buildReadOnlyProxyHeaders(req),
        localHost: PROXY_LOCAL_HOST,
      });
    } catch (error) {
      process.stderr.write(chalk.red(`  [proxy] ${(error as Error).message}\n`));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Proxy error');
      }
    }
  });

  server.on('upgrade', (_req, socket) => {
    rejectUpgrade(socket);
  });
  server.on('connect', (_req, socket) => {
    rejectUpgrade(socket);
  });

  return listenLocalProxy(server);
}
