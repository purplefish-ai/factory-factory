// The egress recorder: a loopback HTTP proxy that refuses every request and
// every CONNECT with 403 and appends one line per attempt to a log. It writes
// only the method and the target host and port, never a header, path or body,
// so a credential that reaches it goes no further than this process's memory.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const REFUSAL = 'sandbox: outbound request refused\n';

/** `host:port` from a proxy-form URL, a CONNECT authority or a Host value; null if unusable. */
export function egressTarget(requestTarget, hostHeader) {
  const fromUrl = (text, defaultScheme) => {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${defaultScheme}://${text}`;
    if (!URL.canParse(candidate)) {
      return null;
    }
    const url = new URL(candidate);
    if (!url.hostname) {
      return null;
    }
    const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
    return `${url.hostname}:${port}`;
  };
  if (requestTarget && !requestTarget.startsWith('/')) {
    return fromUrl(requestTarget, 'http');
  }
  return hostHeader ? fromUrl(hostHeader, 'http') : null;
}

/** One log line: time, method, target. Anything outside a host:port alphabet is dropped. */
export function formatEgressLine(method, target, now = new Date()) {
  const safeMethod = /^[A-Z]{1,16}$/.test(method ?? '') ? method : 'UNKNOWN';
  const safeTarget = target && /^[A-Za-z0-9.\-[\]:_]{1,300}$/.test(target) ? target : 'unknown';
  return `${now.toISOString()} ${safeMethod} ${safeTarget}\n`;
}

/** Starts the recorder on an ephemeral loopback port. */
export async function startEgressRecorder({ logFile, host = '127.0.0.1' }) {
  writeFileSync(logFile, '', { flag: 'a' });
  const record = (method, target) => appendFileSync(logFile, formatEgressLine(method, target));
  const refuseSocket = (socket) => {
    socket.on('error', () => undefined);
    socket.end(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${REFUSAL.length}\r\nConnection: close\r\n\r\n${REFUSAL}`
    );
  };
  const server = createServer((request, response) => {
    record(request.method, egressTarget(request.url, request.headers.host));
    response.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
    response.end(REFUSAL);
    // The body is never read; drop the connection instead.
    request.socket.on('error', () => undefined);
    response.on('finish', () => request.socket.destroy());
  });
  server.on('connect', (request, socket) => {
    record('CONNECT', egressTarget(request.url, undefined));
    refuseSocket(socket);
  });
  server.on('upgrade', (request, socket) => {
    record(request.method, egressTarget(request.url, request.headers.host));
    refuseSocket(socket);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      refuseSocket(socket);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
