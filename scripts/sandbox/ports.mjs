// Port discovery: free ports for `ff serve`, and the ports it reports back.
import { createServer } from 'node:net';

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function parsePort(text) {
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** The port the backend reports with `BACKEND_PORT:<port>`, or null. */
export function parseBackendPort(output) {
  const match = /(?:^|\n)BACKEND_PORT:(\d+)\r?\n/.exec(output);
  return match ? parsePort(match[1]) : null;
}

/** The frontend port `ff serve` writes to `.factory-factory-port` once ready, or null. */
export function parsePortFile(contents) {
  return /^\d+$/.test(contents.trim()) ? parsePort(contents.trim()) : null;
}
