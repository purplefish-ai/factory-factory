export interface ServeEnvOptions {
  dev?: boolean;
  host: string;
}

export function buildServeEnv(
  options: ServeEnvOptions,
  databasePath: string,
  frontendPort: number,
  backendPort: number,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const corsHost = options.host === '0.0.0.0' ? 'localhost' : options.host;
  const corsOrigins = options.dev
    ? `http://${corsHost}:${frontendPort}`
    : `http://${corsHost}:${backendPort}`;

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
