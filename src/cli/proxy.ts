import { type ChildProcess, execFile } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { runMigrationsWithBackup } from '@/backend/migrate-with-backup';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';
import {
  type AuthenticationCheck,
  appendBoundedOutputBuffer,
  authenticateRequest as authenticateProxyRequest,
  createSessionValue,
  createAuthCookie as createSharedAuthCookie,
  extractTryCloudflareUrl,
  matchesToken,
  mergeSetCookieValues,
  parseCookieHeader,
  proxyAuthenticatedHttpRequest,
  proxyAuthenticatedWebSocketUpgrade,
  signValue,
  startCloudflaredTunnel,
  toSafeRedirectPath,
  verifySessionValue,
} from '@/shared/proxy-utils';
import { resolveDatabasePath } from './database-path';
import { describeMigrationFailure, resolveUnknownMigrationPolicy } from './migration-policy';
import { BruteForceGuard, GlobalPasswordLockout } from './proxy-brute-force';
import { type ListeningLocalProxy, listenLocalProxy, PROXY_LOCAL_HOST } from './proxy-listen';
import {
  PUBLIC_MODE_WARNING,
  type ProxyCommandOptions,
  type ProxyMode,
  resolveProxyMode,
} from './proxy-mode';
import { createReadOnlyProxy } from './proxy-read-only';
import { decideTunnelOrigin, toTunnelOrigin } from './proxy-tunnel-origin';
import { ensureDataDir, findAvailablePort, treeKillAsync } from './runtime-utils';
import { startFactoryFactoryServer } from './server-startup';
import { supportsTerminalQrRendering, tryRenderTerminalQrCode } from './terminal-qr';

export { startFactoryFactoryServer } from './server-startup';

const execFileAsync = promisify(execFile);

const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PASSWORD_LENGTH = 6;
// `__Host-` makes browsers reject the cookie unless it is Secure, host-only and
// Path=/, so no other host can set or shadow it.
const SESSION_COOKIE_NAME = '__Host-ff_proxy_session';
const LOGIN_PATH = '/__proxy_auth/login';
const LOCAL_HOST = PROXY_LOCAL_HOST;

interface RunProxyCommandParams {
  options: ProxyCommandOptions;
  projectRoot: string;
}

type ProcessRecord = { name: string; proc: ChildProcess };

async function printDirectLinkQrCode(url: string): Promise<void> {
  if (!supportsTerminalQrRendering()) {
    return;
  }
  const qr = await tryRenderTerminalQrCode(url);
  if (!qr) {
    return;
  }

  console.log(chalk.green('📱 Scan direct link:'));
  process.stdout.write(`${qr}\n`);
}

function generatePassword(length = PASSWORD_LENGTH): string {
  let output = '';
  for (let i = 0; i < length; i += 1) {
    const index = randomInt(PASSWORD_CHARS.length);
    output += PASSWORD_CHARS[index] ?? PASSWORD_CHARS[0] ?? 'A';
  }
  return output;
}

function generateMagicToken(): string {
  return randomBytes(16).toString('hex');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function matchesMagicToken(candidate: string, expected: string): boolean {
  return matchesToken(candidate, expected);
}

function matchesPassword(candidate: string, expected: string): boolean {
  return matchesMagicToken(candidate, expected);
}

function getClientIp(req: IncomingMessage): string {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
    return xForwardedFor.split(',')[0]?.trim() || 'unknown';
  }

  return req.socket.remoteAddress || 'unknown';
}

function runMigrations(projectRoot: string, databasePath: string): Promise<void> {
  const migrationsPath = join(projectRoot, 'prisma', 'migrations');
  return runMigrationsWithBackup({
    databasePath,
    migrationsPath,
    log: () => {
      // silent for proxy command
    },
    unknownMigrations: resolveUnknownMigrationPolicy({ env: getCurrentProcessEnv() }),
  });
}

async function killProcessTree(proc: ChildProcess): Promise<void> {
  if (!proc.pid) {
    return;
  }

  try {
    await treeKillAsync(proc.pid, 'SIGTERM');
  } catch {
    // Ignore kill failures for best-effort cleanup.
  }
}

async function ensureCloudflaredInstalled(): Promise<void> {
  try {
    await execFileAsync('cloudflared', ['--version'], { timeout: 5000 });
  } catch {
    console.error(chalk.red('\n❌ cloudflared is not installed.\n'));
    console.error('Install it:');
    console.error('  macOS:    brew install cloudflared');
    console.error(
      '  Linux:    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared'
    );
    console.error('  Windows:  winget install Cloudflare.cloudflared');
    console.error('\nThen re-run this command.');
    process.exit(1);
  }
}

function createLoginPage(errorMessage?: string): string {
  const escapedErrorMessage = errorMessage ? escapeHtml(errorMessage) : '';
  const errorHtml = escapedErrorMessage
    ? `<p style="color:#dc2626;font-family:system-ui, sans-serif;margin:0 0 16px 0;">${escapedErrorMessage}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Factory Factory Proxy</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at top, #f5f7ff, #eef2ff 45%, #e2e8f0 100%);
      font-family: system-ui, sans-serif;
      color: #0f172a;
    }
    .card {
      width: min(420px, calc(100vw - 24px));
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 18px;
      padding: 24px;
      box-shadow: 0 20px 45px rgba(15, 23, 42, 0.15);
      box-sizing: border-box;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0 0 20px 0;
      color: #334155;
      line-height: 1.5;
      font-size: 14px;
    }
    form {
      display: grid;
      gap: 18px;
    }
    .otp {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
    }
    .otp input {
      width: 100%;
      min-width: 0;
      aspect-ratio: 1 / 1;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      text-align: center;
      font-size: 24px;
      font-weight: 700;
      text-transform: uppercase;
      background: #fff;
      box-sizing: border-box;
    }
    .otp input:focus {
      outline: 2px solid #3b82f6;
      outline-offset: 1px;
      border-color: #3b82f6;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 14px;
      font-weight: 600;
      background: #0f172a;
      color: #fff;
      cursor: pointer;
    }
    button:hover { background: #1e293b; }
    @media (max-width: 420px) {
      .card {
        border-radius: 14px;
        padding: 16px;
      }
      .otp {
        gap: 6px;
      }
      .otp input {
        font-size: 20px;
      }
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Enter Access Code</h1>
    <p>This Factory Factory demo is password-protected.</p>
    ${errorHtml}
    <form method="post" action="${LOGIN_PATH}" id="login-form">
      <input type="hidden" name="password" id="password" />
      <div class="otp" aria-label="Password fields">
        <input inputmode="text" maxlength="1" autocomplete="one-time-code" />
        <input inputmode="text" maxlength="1" autocomplete="one-time-code" />
        <input inputmode="text" maxlength="1" autocomplete="one-time-code" />
        <input inputmode="text" maxlength="1" autocomplete="one-time-code" />
        <input inputmode="text" maxlength="1" autocomplete="one-time-code" />
        <input inputmode="text" maxlength="1" autocomplete="one-time-code" />
      </div>
      <button type="submit">Continue</button>
    </form>
  </main>
  <script>
    const form = document.getElementById('login-form');
    const hidden = document.getElementById('password');
    const inputs = Array.from(form.querySelectorAll('.otp input'));

    const normalize = (value) => value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(-1);

    inputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        input.value = normalize(input.value);
        if (input.value && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !input.value && index > 0) {
          inputs[index - 1].focus();
        }
      });

      input.addEventListener('paste', (event) => {
        const pasted = (event.clipboardData || window.clipboardData).getData('text') || '';
        const chars = pasted.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, inputs.length).split('');
        if (chars.length === 0) {
          return;
        }
        event.preventDefault();
        inputs.forEach((otpInput, otpIndex) => {
          otpInput.value = chars[otpIndex] || '';
        });
        const nextIndex = Math.min(chars.length, inputs.length - 1);
        inputs[nextIndex].focus();
      });
    });

    form.addEventListener('submit', (event) => {
      const value = inputs.map((input) => normalize(input.value)).join('');
      hidden.value = value;
      if (value.length !== inputs.length) {
        event.preventDefault();
        inputs.find((input) => !input.value)?.focus();
      }
    });

    inputs[0].focus();
  </script>
</body>
</html>`;
}

function parseFormBody(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const output: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    output[key] = value;
  }
  return output;
}

function writeRateLimitResponse(
  res: import('node:http').ServerResponse,
  retryAfterSeconds: number
): void {
  res.statusCode = 429;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(createLoginPage(`Too many attempts. Try again in ${retryAfterSeconds} seconds.`));
}

function writeUnauthorizedResponse(
  res: import('node:http').ServerResponse,
  message: string,
  ipLocked = false
): void {
  res.statusCode = ipLocked ? 429 : 401;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(createLoginPage(message));
}

function createAuthCookie(session: ReturnType<typeof createSessionValue>): string {
  return createSharedAuthCookie(session, SESSION_COOKIE_NAME);
}

function authenticateRequest(params: {
  req: IncomingMessage;
  cookieSecret: Buffer;
  magicToken: string;
}): AuthenticationCheck {
  return authenticateProxyRequest({
    req: params.req,
    cookieSecret: params.cookieSecret,
    authToken: params.magicToken,
    sessionCookieName: SESSION_COOKIE_NAME,
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    chunks.push(value);

    const size = chunks.reduce((acc, current) => acc + current.length, 0);
    if (size > 4096) {
      throw new Error('Request body too large');
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

function setSessionCookie(res: import('node:http').ServerResponse, cookieSecret: Buffer): void {
  const session = createSessionValue(cookieSecret);
  res.setHeader('Set-Cookie', createAuthCookie(session));
}

function writeLoginPage(res: import('node:http').ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(createLoginPage());
}

interface AuthProxyState {
  upstreamPort: number;
  password: string;
  magicToken: string;
  cookieSecret: Buffer;
  guard: BruteForceGuard;
  passwordLockout: GlobalPasswordLockout;
  /** The tunnel's public origin, once cloudflared has reported it. */
  tunnelOrigin: string | null;
}

function writeGlobalLockoutResponse(
  res: import('node:http').ServerResponse,
  retryAfterSeconds: number
): void {
  res.statusCode = 429;
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    createLoginPage(
      `Too many failed sign-in attempts. Try again in ${retryAfterSeconds} seconds, or use the direct link.`
    )
  );
}

function registerFailureAndRespond(params: {
  guard: BruteForceGuard;
  ip: string;
  res: import('node:http').ServerResponse;
  message: string;
}): 'handled' {
  const failure = params.guard.registerFailure(params.ip);
  if (failure.ipLocked) {
    const retry = params.guard.isLocked(params.ip);
    writeUnauthorizedResponse(
      params.res,
      `Too many failed attempts. Try again in ${retry.retryAfterSeconds} seconds.`,
      true
    );
    return 'handled';
  }

  writeUnauthorizedResponse(params.res, params.message);
  return 'handled';
}

async function handleLoginSubmission(params: {
  req: IncomingMessage;
  res: import('node:http').ServerResponse;
  state: AuthProxyState;
  ip: string;
}): Promise<'handled'> {
  const { state } = params;
  let submittedPassword = '';
  try {
    const body = await readRequestBody(params.req);
    const form = parseFormBody(body);
    submittedPassword = (form.password || '').trim().toUpperCase();
  } catch {
    submittedPassword = '';
  }

  // Locked clients get 429 before the body is read; check again because concurrent
  // attempts may have triggered a lockout while this body was read. No await
  // separates these checks from the comparison and the failure it records, so
  // the global limit is exact.
  const lockState = state.guard.isLocked(params.ip);
  if (lockState.locked) {
    writeRateLimitResponse(params.res, lockState.retryAfterSeconds);
    return 'handled';
  }
  const globalRetryAfter = state.passwordLockout.retryAfterSeconds();
  if (globalRetryAfter > 0) {
    writeGlobalLockoutResponse(params.res, globalRetryAfter);
    return 'handled';
  }

  if (submittedPassword && matchesPassword(submittedPassword, state.password)) {
    setSessionCookie(params.res, state.cookieSecret);
    params.res.statusCode = 302;
    params.res.setHeader('Location', '/');
    params.res.end();
    return 'handled';
  }

  state.passwordLockout.registerFailure();
  return registerFailureAndRespond({
    guard: state.guard,
    ip: params.ip,
    res: params.res,
    message: 'Invalid password. Please try again.',
  });
}

/** The backend's own loopback origin; it accepts this as a same-origin request. */
function getBackendOrigin(state: AuthProxyState): string {
  return `http://localhost:${state.upstreamPort}`;
}

async function handleAuthHttpRequest(params: {
  req: IncomingMessage;
  res: import('node:http').ServerResponse;
  state: AuthProxyState;
}): Promise<void> {
  const { state } = params;
  const ip = getClientIp(params.req);
  const lockState = state.guard.isLocked(ip);
  const isLoginPath = params.req.url?.startsWith(LOGIN_PATH) ?? false;
  const isLoginSubmission = params.req.method === 'POST' && isLoginPath;

  if (lockState.locked) {
    writeRateLimitResponse(params.res, lockState.retryAfterSeconds);
    return;
  }

  const auth = authenticateRequest({
    req: params.req,
    cookieSecret: state.cookieSecret,
    magicToken: state.magicToken,
  });

  if (isLoginSubmission) {
    const globalRetryAfter = state.passwordLockout.retryAfterSeconds();
    if (globalRetryAfter > 0) {
      writeGlobalLockoutResponse(params.res, globalRetryAfter);
      return;
    }
    await handleLoginSubmission({ req: params.req, res: params.res, state, ip });
    return;
  }

  if (!auth.authenticated) {
    if (auth.invalidToken) {
      registerFailureAndRespond({
        guard: state.guard,
        ip,
        res: params.res,
        message: 'Invalid token. Please use the shared link again.',
      });
      return;
    }

    writeLoginPage(params.res);
    return;
  }

  const origin = decideTunnelOrigin({
    method: params.req.method,
    origin: params.req.headers.origin,
    isUpgrade: false,
    tunnelOrigin: state.tunnelOrigin,
    backendOrigin: getBackendOrigin(state),
  });
  if (!origin.allowed) {
    params.res.statusCode = origin.status;
    params.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    params.res.setHeader('Cache-Control', 'no-store');
    params.res.setHeader('Connection', 'close');
    params.res.end(origin.message);
    return;
  }

  if (auth.viaToken) {
    setSessionCookie(params.res, state.cookieSecret);
  }

  proxyAuthenticatedHttpRequest({
    req: params.req,
    res: params.res,
    upstreamPort: state.upstreamPort,
    path: auth.sanitizedPath,
    sessionCookieName: SESSION_COOKIE_NAME,
    localHost: LOCAL_HOST,
    upstreamOrigin: origin.upstreamOrigin,
  });
}

const UPGRADE_STATUS_TEXT = {
  401: 'Unauthorized',
  403: 'Forbidden',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
} as const;

function rejectUpgrade(socket: Duplex, status: keyof typeof UPGRADE_STATUS_TEXT): void {
  socket.end(
    `HTTP/1.1 ${status} ${UPGRADE_STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

function handleAuthUpgrade(
  state: AuthProxyState,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const ip = getClientIp(req);
  if (state.guard.isLocked(ip).locked) {
    rejectUpgrade(socket, 429);
    return;
  }

  const auth = authenticateRequest({
    req,
    cookieSecret: state.cookieSecret,
    magicToken: state.magicToken,
  });
  if (!auth.authenticated) {
    if (auth.invalidToken) {
      state.guard.registerFailure(ip);
    }
    rejectUpgrade(socket, 401);
    return;
  }

  const origin = decideTunnelOrigin({
    method: req.method,
    origin: req.headers.origin,
    isUpgrade: true,
    tunnelOrigin: state.tunnelOrigin,
    backendOrigin: getBackendOrigin(state),
  });
  if (!origin.allowed) {
    rejectUpgrade(socket, origin.status);
    return;
  }

  proxyAuthenticatedWebSocketUpgrade({
    req,
    socket,
    head,
    upstreamPort: state.upstreamPort,
    sanitizedPath: auth.sanitizedPath,
    sessionCookieName: SESSION_COOKIE_NAME,
    localHost: LOCAL_HOST,
    upstreamOrigin: origin.upstreamOrigin,
  });
}

interface AuthProxy extends ListeningLocalProxy {
  /** Records the URL cloudflared printed; requests carrying an Origin must match it. */
  setTunnelUrl: (publicUrl: string) => void;
}

/**
 * The proxy behind a password-protected tunnel. It authenticates every request
 * (signed session cookie or the direct-link token), lets only the tunnel's own
 * origin change state or open WebSockets, and forwards those to the backend as
 * same-origin requests without client-address headers.
 */
async function createAuthProxy(params: {
  upstreamPort: number;
  password: string;
  magicToken: string;
}): Promise<AuthProxy> {
  const state: AuthProxyState = {
    upstreamPort: params.upstreamPort,
    password: params.password,
    magicToken: params.magicToken,
    cookieSecret: randomBytes(32),
    guard: new BruteForceGuard(),
    passwordLockout: new GlobalPasswordLockout(),
    tunnelOrigin: null,
  };

  const server = createHttpServer((req, res) => {
    void handleAuthHttpRequest({ req, res, state }).catch((error) => {
      process.stderr.write(chalk.red(`  [proxy] ${(error as Error).message}\n`));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Proxy error');
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    handleAuthUpgrade(state, req, socket, head);
  });

  const listening = await listenLocalProxy(server);
  return {
    ...listening,
    setTunnelUrl: (publicUrl) => {
      state.tunnelOrigin = toTunnelOrigin(publicUrl);
    },
  };
}

function createExitPromise(
  proc: ChildProcess,
  name: string,
  shutdownState: { shuttingDown: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.once('exit', (code, signal) => {
      if (shutdownState.shuttingDown) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${name} exited unexpectedly (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`
        )
      );
    });

    proc.once('error', (error) => {
      if (shutdownState.shuttingDown) {
        resolve();
        return;
      }
      reject(new Error(`${name} failed: ${(error as Error).message}`));
    });
  });
}

export async function runProxyCommand({
  options,
  projectRoot,
}: RunProxyCommandParams): Promise<void> {
  let mode: ProxyMode;
  try {
    mode = resolveProxyMode(options);
  } catch (error) {
    console.error(chalk.red(`\n❌ ${(error as Error).message}`));
    process.exit(1);
    return;
  }
  const usePrivateMode = mode === 'private';
  const shutdownState = { shuttingDown: false };
  const processes: ProcessRecord[] = [];
  let localProxyClose: (() => Promise<void>) | null = null;
  let signalHandlersAttached = false;

  const shutdown = async (exitCode: number, message?: string) => {
    if (shutdownState.shuttingDown) {
      return;
    }
    shutdownState.shuttingDown = true;
    detachSignalHandlers();

    if (message) {
      if (exitCode === 0) {
        console.log(chalk.yellow(`\n${message}`));
      } else {
        console.error(chalk.red(`\n${message}`));
      }
    }

    if (localProxyClose) {
      try {
        await localProxyClose();
      } catch {
        // Ignore close failures during shutdown.
      }
    }

    await Promise.all(processes.map(async ({ proc }) => killProcessTree(proc)));
    process.exit(exitCode);
  };

  const onSigint = () => {
    void shutdown(0, 'SIGINT received, shutting down...');
  };
  const onSigterm = () => {
    void shutdown(0, 'SIGTERM received, shutting down...');
  };

  const detachSignalHandlers = () => {
    if (!signalHandlersAttached) {
      return;
    }
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    signalHandlersAttached = false;
  };

  const attachSignalHandlers = () => {
    if (signalHandlersAttached) {
      return;
    }
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    signalHandlersAttached = true;
  };

  await ensureCloudflaredInstalled();

  const databasePath = resolveDatabasePath();
  ensureDataDir(databasePath);
  try {
    await runMigrations(projectRoot, databasePath);
  } catch (error) {
    console.error(chalk.red(`\n❌ ${describeMigrationFailure(error)}`));
    detachSignalHandlers();
    process.exit(1);
    return;
  }

  const requestedPort = await findAvailablePort(3001, { maxAttempts: 50 });
  console.log(chalk.blue(`Starting server on port ${requestedPort}...`));

  let backend: { process: ChildProcess; port: number };
  attachSignalHandlers();
  try {
    backend = await startFactoryFactoryServer({
      projectRoot,
      databasePath,
      requestedPort,
    });
  } catch (error) {
    console.error(chalk.red(`\n❌ ${(error as Error).message}`));
    detachSignalHandlers();
    process.exit(1);
    return;
  }

  processes.push({ name: 'server', proc: backend.process });

  let password: string | null = null;
  let directToken: string | null = null;

  // cloudflared always targets a local proxy, never the backend directly.
  let localProxy: ListeningLocalProxy;
  let setTunnelUrl: ((publicUrl: string) => void) | null = null;
  try {
    if (usePrivateMode) {
      password = generatePassword();
      directToken = generateMagicToken();
      const authProxy = await createAuthProxy({
        upstreamPort: backend.port,
        password,
        magicToken: directToken,
      });
      localProxy = authProxy;
      setTunnelUrl = authProxy.setTunnelUrl;
    } else {
      localProxy = await createReadOnlyProxy({ upstreamPort: backend.port });
    }
  } catch (error) {
    await shutdown(1, `❌ ${(error as Error).message}`);
    return;
  }
  const targetPort = localProxy.port;
  localProxyClose = localProxy.close;

  console.log(chalk.blue(usePrivateMode ? 'Starting tunnel...' : 'Starting public tunnel...'));

  let tunnel: { proc: ChildProcess; publicUrl: string };
  try {
    tunnel = await startCloudflaredTunnel({
      targetUrl: `http://${LOCAL_HOST}:${targetPort}`,
      killProcess: (proc) => killProcessTree(proc),
    });
  } catch (error) {
    await shutdown(1, `❌ ${(error as Error).message}`);
    return;
  }

  processes.push({ name: 'cloudflared', proc: tunnel.proc });
  try {
    setTunnelUrl?.(tunnel.publicUrl);
  } catch (error) {
    await shutdown(1, `❌ ${(error as Error).message}`);
    return;
  }

  if (usePrivateMode && password && directToken) {
    const directLink = `${tunnel.publicUrl}?token=${directToken}`;
    console.log(chalk.green(`🌍 Public URL:  ${tunnel.publicUrl}`));
    console.log(chalk.green(`🔑 Password:   ${password}`));
    console.log(chalk.green(`🔗 Direct link: ${directLink}\n`));
    await printDirectLinkQrCode(directLink);
    console.log('Share the password or direct link with people you want to grant access.');
    console.log('Press Ctrl+C to stop.');
  } else {
    console.log(chalk.green(`🌍 Public URL:  ${tunnel.publicUrl}\n`));
    console.log(chalk.yellow(`${PUBLIC_MODE_WARNING}\n`));
    console.log('Press Ctrl+C to stop.');
  }

  try {
    await Promise.race([
      createExitPromise(backend.process, 'Factory Factory server', shutdownState),
      createExitPromise(tunnel.proc, 'cloudflared', shutdownState),
    ]);
  } catch (error) {
    await shutdown(1, `❌ ${(error as Error).message}`);
    return;
  }
}

export const proxyInternals = {
  BruteForceGuard,
  createSessionValue,
  createAuthCookie,
  authenticateRequest,
  createLoginPage,
  escapeHtml,
  extractTryCloudflareUrl,
  appendBoundedOutputBuffer,
  generatePassword,
  generateMagicToken,
  mergeSetCookieValues,
  matchesMagicToken,
  matchesPassword,
  createAuthProxy,
  toSafeRedirectPath,
  supportsTerminalQrRendering,
  tryRenderTerminalQrCode,
  parseCookieHeader,
  signValue,
  verifySessionValue,
};
