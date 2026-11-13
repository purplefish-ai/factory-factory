// The server's environment: an allowlist from the launcher plus sandbox paths.
import { delimiter, dirname } from 'node:path';
import { sandboxPaths } from './paths.mjs';

/** Parent variables the server keeps; everything else, including credentials, is dropped. */
const INHERITED_VARIABLES = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'TZ'];

/** Hosts that never go through the egress recorder: the sandbox's own servers. */
const LOOPBACK_HOSTS = '127.0.0.1,localhost,::1';

/** `git` runs GIT_SSH_COMMAND through a shell. */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Lets a caller point the release check at a local registry; never one carrying credentials. */
function registryUrlWithoutCredentials(value) {
  if (!(value && URL.canParse(value))) {
    return undefined;
  }
  const url = new URL(value);
  return url.username || url.password ? undefined : value;
}

/**
 * The proxy variables send to the egress recorder, which refuses and records
 * each request: the application's built-in `fetch` and `http`/`https` requests
 * (Node honours the variables only with `NODE_USE_ENV_PROXY=1`), `git` over
 * HTTP(S) and the Claude runtime, whose API base URL is the recorder itself.
 * (`git` normally refuses HTTP(S) and SSH itself, below, before the recorder
 * or the ssh shim sees anything; they are its second line.) WebSocket clients and clients that bring their own agent ignore them: the
 * sandbox relies on those having no credential (voice narration) or being
 * switched off (Slack intake, below). See USAGE for what is not contained.
 */
function egressVariables(egressPort) {
  const proxy = `http://127.0.0.1:${egressPort}`;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: LOOPBACK_HOSTS,
    no_proxy: LOOPBACK_HOSTS,
    NODE_USE_ENV_PROXY: '1',
    ANTHROPIC_BASE_URL: proxy,
  };
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
  egressPort,
  nodeDir = dirname(process.execPath),
}) {
  if (!(Number.isInteger(egressPort) && egressPort > 0)) {
    throw new Error('The server environment needs the egress recorder port.');
  }
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
    // Projects (by path or by clone) must live inside the sandbox.
    FF_PROJECT_ROOT: baseDir,
    WORKTREE_BASE_DIR: paths.worktreeBaseDir,
    CODEX_HOME: paths.codexHome,
    CODEX_PATH: paths.codex,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    // Claude Code's documented switches for non-essential traffic and telemetry.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    ...egressVariables(egressPort),
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // `git` reaches no remote: local paths only, no prompt, and `ssh` is the shim
    // even when a repository's `core.sshCommand` names another program.
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: shellQuote(paths.ssh),
    // The backend loads dotenv from the checkout; read an empty file instead.
    DOTENV_PATH: paths.dotenv,
    DOTENV_QUIET: 'true',
    FF_EMIT_BACKEND_PORT: '1',
    FF_UPDATE_CHECKS_ENABLED: 'false',
    AGENT_SLACK_INTAKE_ENABLED: 'false',
    FF_SANDBOX_SCENARIO: scenario,
  };
}
