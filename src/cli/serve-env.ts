import { isIPv6 } from 'node:net';

export interface ServeEnvOptions {
  dev?: boolean;
  host: string;
}

const ALL_INTERFACES_HOSTS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']);

/**
 * Builds an `http://host:port` origin, bracketing and compressing IPv6 literals
 * as browsers send them in the `Origin` header (RFC 3986 / RFC 5952).
 */
export function buildHttpOrigin(host: string, port: number): string {
  return `http://${formatUrlHost(host)}:${port}`;
}

function formatUrlHost(host: string): string {
  if (!isIPv6(host)) {
    return host;
  }
  try {
    // The URL parser serializes IPv6 hosts in the compressed form browsers use
    // in `Origin` (e.g. `0:0:0:0:0:0:0:1` -> `[::1]`).
    return new URL(`http://[${host}]`).hostname;
  } catch {
    return `[${host}]`;
  }
}

export function buildServeEnv(
  options: ServeEnvOptions,
  databasePath: string,
  frontendPort: number,
  backendPort: number,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const corsHost = ALL_INTERFACES_HOSTS.has(options.host) ? 'localhost' : options.host;
  const corsOrigins = buildHttpOrigin(corsHost, options.dev ? frontendPort : backendPort);

  return {
    ...baseEnv,
    DATABASE_PATH: databasePath,
    FRONTEND_PORT: frontendPort.toString(),
    BACKEND_HOST: options.host,
    BACKEND_PORT: backendPort.toString(),
    NODE_ENV: options.dev ? 'development' : 'production',
    CORS_ALLOWED_ORIGINS: baseEnv.CORS_ALLOWED_ORIGINS || corsOrigins,
  };
}
