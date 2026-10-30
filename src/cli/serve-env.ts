import { isIPv6 } from 'node:net';

export interface ServeEnvOptions {
  dev?: boolean;
  host: string;
}

const ALL_INTERFACES_HOSTS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']);

/**
 * Builds an `http://host:port` origin, bracketing IPv6 literals as RFC 3986
 * requires (and as browsers send them in the `Origin` header).
 */
export function buildHttpOrigin(host: string, port: number): string {
  const urlHost = isIPv6(host) ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
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
