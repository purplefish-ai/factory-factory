// The server's environment: an allowlist from the launcher plus sandbox paths.
import { delimiter, dirname, join } from 'node:path';
import { sandboxPaths } from './paths.mjs';

/** Parent variables the server keeps; everything else, including credentials, is dropped. */
const INHERITED_VARIABLES = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'TZ'];

/** Lets a caller point the release check at a local registry; never one carrying credentials. */
function registryUrlWithoutCredentials(value) {
  if (!(value && URL.canParse(value))) {
    return undefined;
  }
  const url = new URL(value);
  return url.username || url.password ? undefined : value;
}

/**
 * The complete server environment. Only the variables above are inherited, so
 * no API key, OAuth token or other credential in the launcher's environment
 * reaches the server, its providers or `git`, and `HOME` is inside the sandbox.
 * `nodeDir` (this Node's directory) precedes the rest of `PATH`, so `node`
 * never resolves to a version-manager shim that needs the real `HOME`.
 */
export function buildServerEnv({
  parentEnv,
  baseDir,
  scenario,
  nodeDir = dirname(process.execPath),
}) {
  const paths = sandboxPaths(baseDir);
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && (INHERITED_VARIABLES.includes(name) || name.startsWith('LC_'))) {
      env[name] = value;
    }
  }
  const registryUrl = registryUrlWithoutCredentials(parentEnv.FF_NPM_REGISTRY_URL);
  return {
    ...env,
    ...(registryUrl ? { FF_NPM_REGISTRY_URL: registryUrl } : {}),
    PATH: [paths.binDir, nodeDir, parentEnv.PATH].filter(Boolean).join(delimiter),
    HOME: paths.home,
    BASE_DIR: baseDir,
    WORKTREE_BASE_DIR: paths.worktreeBaseDir,
    CODEX_HOME: paths.codexHome,
    CODEX_PATH: join(paths.binDir, 'codex'),
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // The backend loads dotenv from the checkout; read an empty file instead.
    DOTENV_PATH: paths.dotenv,
    DOTENV_QUIET: 'true',
    FF_EMIT_BACKEND_PORT: '1',
    FF_UPDATE_CHECKS_ENABLED: 'false',
    AGENT_SLACK_INTAKE_ENABLED: 'false',
    FF_SANDBOX_SCENARIO: scenario,
  };
}
