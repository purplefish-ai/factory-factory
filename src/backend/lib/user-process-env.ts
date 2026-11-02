/**
 * Variables Factory Factory's launchers (`ff serve`, `ff proxy`/`ff tailscale`
 * and the desktop app) set to configure its own backend. They describe the
 * Factory Factory server, not the user's project.
 */
const FACTORY_RUNTIME_ENV_KEYS = [
  // NODE_ENV=production makes npm/yarn omit devDependencies and runs dev
  // servers in production mode.
  'NODE_ENV',
  'DATABASE_PATH',
  'MIGRATIONS_PATH',
  'BACKEND_HOST',
  'BACKEND_PORT',
  'FRONTEND_PORT',
  'FRONTEND_STATIC_PATH',
  'WS_LOGS_PATH',
  'CORS_ALLOWED_ORIGINS',
  'DISABLE_CORS_CHECKS',
  'TRUST_PROXY_HEADERS',
  'DOTENV_CONFIG_OVERRIDE',
  'DOTENV_OVERRIDE',
  'FF_RUN_SCRIPT_PROXY_ENABLED',
] as const;

/**
 * Environment for processes that run the user's own commands (terminals and
 * setup/run/postRun/cleanup scripts): the backend's environment without the
 * variables its launcher set for Factory Factory itself.
 */
export function buildUserProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of FACTORY_RUNTIME_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
