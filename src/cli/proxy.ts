import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { runMigrations as runDbMigrations } from '@/backend/migrate';
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
  removeHopByHopHeaders,
  signValue,
  toSafeRedirectPath,
  verifySessionValue,
} from '../shared/proxy-utils';
import { ensureDataDir, findAvailablePort, treeKillAsync, waitForPort } from './runtime-utils';

const execFileAsync = promisify(execFile);

const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PASSWORD_LENGTH = 6;
const SESSION_COOKIE_NAME = 'ff_proxy_session';
const LOGIN_PATH = '/__proxy_auth/login';
const LOCAL_HOST = '127.0.0.1';
const MAX_TUNNEL_OUTPUT_BUFFER_CHARS = 8192;
const LOCKOUT_THRESHOLD_PER_IP = 5;
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;
const MAX_BRUTE_FORCE_TRACKED_IPS = 5000;

interface ProxyCommandOptions {
  private?: boolean;
}

interface RunProxyCommandParams {
  options: ProxyCommandOptions;
  projectRoot: string;
}

type ProcessRecord = { name: string; proc: ChildProcess };

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

class BruteForceGuard {
  private readonly attemptsByIp = new Map<
    string,
    { failures: number; lockedUntilMs: number; lastSeenMs: number }
  >();

  private evictStaleEntries(nowMs: number): void {
    for (const [ip, state] of this.attemptsByIp.entries()) {
      const lockExpired = state.lockedUntilMs <= nowMs;
      const stale = nowMs - state.lastSeenMs > LOCKOUT_WINDOW_MS;
      if (lockExpired && stale) {
        this.attemptsByIp.delete(ip);
      }
    }

    while (this.attemptsByIp.size > MAX_BRUTE_FORCE_TRACKED_IPS) {
      const oldest = this.attemptsByIp.keys().next().value;
      if (!oldest) {
        break;
      }
      this.attemptsByIp.delete(oldest);
    }
  }

  isLocked(ip: string, nowMs = Date.now()): { locked: boolean; retryAfterSeconds: number } {
    this.evictStaleEntries(nowMs);
    const state = this.attemptsByIp.get(ip);
    if (!state || state.lockedUntilMs <= 0) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    if (state.lockedUntilMs <= nowMs) {
      this.attemptsByIp.delete(ip);
      return { locked: false, retryAfterSeconds: 0 };
    }

    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntilMs - nowMs) / 1000)),
    };
  }

  registerFailure(ip: string, nowMs = Date.now()): { ipLocked: boolean } {
    this.evictStaleEntries(nowMs);
    const current = this.attemptsByIp.get(ip) ?? { failures: 0, lockedUntilMs: 0, lastSeenMs: 0 };
    const normalized =
      current.lockedUntilMs > 0 && current.lockedUntilMs <= nowMs
        ? { failures: 0, lockedUntilMs: 0, lastSeenMs: nowMs }
        : current;

    const nextFailures = normalized.failures + 1;
    const ipLocked = nextFailures >= LOCKOUT_THRESHOLD_PER_IP;

    // Reinsert to keep map order roughly LRU for bounded eviction.
    this.attemptsByIp.delete(ip);
    this.attemptsByIp.set(ip, {
      failures: ipLocked ? 0 : nextFailures,
      lockedUntilMs: ipLocked ? nowMs + LOCKOUT_WINDOW_MS : 0,
      lastSeenMs: nowMs,
    });

    return { ipLocked };
  }
}

function getDefaultDatabasePath(): string {
  return process.env.DATABASE_PATH || join(homedir(), 'factory-factory', 'data.db');
}

function runMigrations(projectRoot: string, databasePath: string): void {
  const migrationsPath = join(projectRoot, 'prisma', 'migrations');
  runDbMigrations({
    databasePath,
    migrationsPath,
    log: () => {
      // silent for proxy command
    },
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

async function startFactoryFactoryServer(params: {
  projectRoot: string;
  databasePath: string;
  requestedPort: number;
}): Promise<{ process: ChildProcess; port: number }> {
  const frontendDist = join(params.projectRoot, 'dist', 'client');
  const backendDist = join(params.projectRoot, 'dist', 'src', 'backend', 'index.js');

  if (!existsSync(frontendDist)) {
    throw new Error('Frontend not built. Run `ff build` or `pnpm build` first.');
  }

  if (!existsSync(backendDist)) {
    throw new Error('Backend not built. Run `ff build` or `pnpm build` first.');
  }

  const backend = spawn('node', [backendDist], {
    cwd: params.projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_PATH: params.databasePath,
      BACKEND_PORT: params.requestedPort.toString(),
      BACKEND_HOST: LOCAL_HOST,
      FF_RUN_SCRIPT_PROXY_ENABLED: '1',
      FRONTEND_STATIC_PATH: frontendDist,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backend.stderr?.on('data', (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (!message) {
      return;
    }
    process.stderr.write(chalk.red(`  [server] ${message}\n`));
  });

  let startupBuffer = '';
  let actualPort: number;
  try {
    actualPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for server startup signal'));
      }, 30_000);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        backend.stdout?.off('data', onStdoutData);
        backend.off('exit', onExit);
        backend.off('error', onError);
      };

      const onStdoutData = (chunk: Buffer) => {
        startupBuffer += chunk.toString();
        const match = startupBuffer.match(/BACKEND_PORT:(\d+)/);
        if (match?.[1]) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isNaN(parsed)) {
            cleanup();
            reject(new Error('Received invalid backend port from server startup'));
            return;
          }
          cleanup();
          resolve(parsed);
          return;
        }

        if (startupBuffer.length > 4096) {
          startupBuffer = startupBuffer.slice(-2048);
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Server exited before startup completed (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`
          )
        );
      };

      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Failed to start backend server: ${error.message}`));
      };

      backend.stdout?.on('data', onStdoutData);
      backend.once('exit', onExit);
      backend.once('error', onError);
    });

    await waitForPort(actualPort, LOCAL_HOST);
  } catch (error) {
    await killProcessTree(backend);
    throw error;
  }

  return { process: backend, port: actualPort };
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
  lockState: { locked: boolean; retryAfterSeconds: number };
  guard: BruteForceGuard;
  ip: string;
  password: string;
  cookieSecret: Buffer;
}): Promise<'handled'> {
  if (params.lockState.locked) {
    writeRateLimitResponse(params.res, params.lockState.retryAfterSeconds);
    return 'handled';
  }

  let submittedPassword = '';
  try {
    const body = await readRequestBody(params.req);
    const form = parseFormBody(body);
    submittedPassword = (form.password || '').trim().toUpperCase();
  } catch {
    submittedPassword = '';
  }

  if (submittedPassword && matchesPassword(submittedPassword, params.password)) {
    setSessionCookie(params.res, params.cookieSecret);
    params.res.statusCode = 302;
    params.res.setHeader('Location', '/');
    params.res.end();
    return 'handled';
  }

  return registerFailureAndRespond({
    guard: params.guard,
    ip: params.ip,
    res: params.res,
    message: 'Invalid password. Please try again.',
  });
}

function proxyAuthenticatedHttpRequest(params: {
  req: IncomingMessage;
  res: import('node:http').ServerResponse;
  upstreamPort: number;
  path: string;
}): void {
  const endProxyErrorResponse = () => {
    if (!params.res.headersSent) {
      params.res.statusCode = 502;
    }
    if (!params.res.writableEnded) {
      params.res.end('Proxy error');
    }
  };

  const upstreamHeaders = removeHopByHopHeaders(params.req.headers, SESSION_COOKIE_NAME);

  const upstreamRequest = httpRequest(
    {
      host: LOCAL_HOST,
      port: params.upstreamPort,
      method: params.req.method,
      path: params.path,
      headers: {
        ...upstreamHeaders,
        host: `localhost:${params.upstreamPort}`,
      },
    },
    (upstreamResponse) => {
      if (upstreamResponse.statusCode) {
        params.res.statusCode = upstreamResponse.statusCode;
      }
      for (const [header, value] of Object.entries(upstreamResponse.headers)) {
        if (typeof value !== 'undefined') {
          if (header.toLowerCase() === 'set-cookie') {
            const existingCookieHeader = params.res.getHeader('set-cookie');
            const mergedCookieHeader = mergeSetCookieValues(existingCookieHeader, value);
            params.res.setHeader('set-cookie', mergedCookieHeader);
          } else {
            params.res.setHeader(header, value);
          }
        }
      }

      upstreamResponse.on('error', endProxyErrorResponse);
      upstreamResponse.on('aborted', endProxyErrorResponse);
      upstreamResponse.pipe(params.res);
    }
  );

  upstreamRequest.on('error', endProxyErrorResponse);

  params.req.on('error', () => {
    if (!(upstreamRequest.destroyed || upstreamRequest.writableEnded)) {
      upstreamRequest.destroy();
    }
    endProxyErrorResponse();
  });

  params.req.pipe(upstreamRequest);
}

async function handleAuthHttpRequest(params: {
  req: IncomingMessage;
  res: import('node:http').ServerResponse;
  upstreamPort: number;
  password: string;
  magicToken: string;
  cookieSecret: Buffer;
  guard: BruteForceGuard;
}): Promise<void> {
  const ip = getClientIp(params.req);
  const lockState = params.guard.isLocked(ip);
  const isLoginPath = params.req.url?.startsWith(LOGIN_PATH) ?? false;
  const isLoginSubmission = params.req.method === 'POST' && isLoginPath;

  if (lockState.locked && !isLoginSubmission) {
    writeRateLimitResponse(params.res, lockState.retryAfterSeconds);
    return;
  }

  const auth = authenticateRequest({
    req: params.req,
    cookieSecret: params.cookieSecret,
    magicToken: params.magicToken,
  });

  if (isLoginSubmission) {
    await handleLoginSubmission({
      req: params.req,
      res: params.res,
      lockState,
      guard: params.guard,
      ip,
      password: params.password,
      cookieSecret: params.cookieSecret,
    });
    return;
  }

  if (!auth.authenticated) {
    if (auth.invalidToken) {
      registerFailureAndRespond({
        guard: params.guard,
        ip,
        res: params.res,
        message: 'Invalid token. Please use the shared link again.',
      });
      return;
    }

    writeLoginPage(params.res);
    return;
  }

  if (auth.viaToken) {
    setSessionCookie(params.res, params.cookieSecret);
  }

  proxyAuthenticatedHttpRequest({
    req: params.req,
    res: params.res,
    upstreamPort: params.upstreamPort,
    path: auth.sanitizedPath,
  });
}

function createAuthProxy(params: {
  upstreamPort: number;
  password: string;
  magicToken: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const bruteForceGuard = new BruteForceGuard();
  const cookieSecret = randomBytes(32);
  const activeSockets = new Set<Socket>();

  const server = createHttpServer((req, res) => {
    void handleAuthHttpRequest({
      req,
      res,
      upstreamPort: params.upstreamPort,
      password: params.password,
      magicToken: params.magicToken,
      cookieSecret,
      guard: bruteForceGuard,
    }).catch((error) => {
      process.stderr.write(chalk.red(`  [proxy] ${(error as Error).message}\n`));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Proxy error');
      }
    });
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => {
      activeSockets.delete(socket);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const ip = getClientIp(req);
    const lockState = bruteForceGuard.isLocked(ip);

    if (lockState.locked) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const auth = authenticateRequest({
      req,
      cookieSecret,
      magicToken: params.magicToken,
    });

    if (!auth.authenticated) {
      if (auth.invalidToken) {
        bruteForceGuard.registerFailure(ip);
      }
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upstreamSocket = createConnection(params.upstreamPort, LOCAL_HOST, () => {
      const headers: Record<string, string | string[] | undefined> = {
        ...removeHopByHopHeaders(req.headers, SESSION_COOKIE_NAME),
        host: `localhost:${params.upstreamPort}`,
        connection: 'Upgrade',
        upgrade: req.headers.upgrade,
      };

      const requestPath = toSafeRedirectPath(auth.sanitizedPath || '/');
      const requestLine = `${req.method || 'GET'} ${requestPath} HTTP/${req.httpVersion}`;
      const headerLines = Object.entries(headers)
        .flatMap(([key, value]) => {
          if (typeof value === 'undefined') {
            return [];
          }
          if (Array.isArray(value)) {
            return value.map((item) => `${key}: ${item}`);
          }
          return [`${key}: ${value}`];
        })
        .join('\r\n');

      upstreamSocket.write(`${requestLine}\r\n${headerLines}\r\n\r\n`);
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket).pipe(socket);
    });

    upstreamSocket.on('error', () => {
      socket.destroy();
    });

    socket.on('error', () => {
      upstreamSocket.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCAL_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine auth proxy port'));
        return;
      }

      resolve({
        port: address.port,
        close: async () => {
          await new Promise<void>((closeResolve) => {
            const timeout = setTimeout(() => {
              closeResolve();
            }, 1000);
            timeout.unref?.();

            server.close(() => {
              clearTimeout(timeout);
              closeResolve();
            });

            for (const socket of activeSockets) {
              socket.destroy();
            }
          });
        },
      });
    });
  });
}

async function startCloudflaredTunnel(
  targetUrl: string
): Promise<{ proc: ChildProcess; publicUrl: string }> {
  const cloudflared = spawn('cloudflared', ['tunnel', '--url', targetUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let resolvedUrl: string | null = null;
  let outputBuffer = '';

  const waitForUrl = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for cloudflared tunnel URL'));
    }, 30_000);
    timeout.unref?.();

    const onData = (data: Buffer) => {
      outputBuffer = appendBoundedOutputBuffer(
        outputBuffer,
        data.toString(),
        MAX_TUNNEL_OUTPUT_BUFFER_CHARS
      );
      const extracted = extractTryCloudflareUrl(outputBuffer);
      if (extracted && !resolvedUrl) {
        resolvedUrl = extracted;
        cleanup();
        resolve(extracted);
      }
    };

    const onExit = (code: number | null) => {
      if (!resolvedUrl) {
        cleanup();
        reject(
          new Error(`cloudflared exited before URL was available (code ${code ?? 'unknown'})`)
        );
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`Failed to start cloudflared: ${(error as Error).message}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      cloudflared.stdout?.off('data', onData);
      cloudflared.stderr?.off('data', onData);
      cloudflared.off('exit', onExit);
      cloudflared.off('error', onError);
    };

    cloudflared.stdout?.on('data', onData);
    cloudflared.stderr?.on('data', onData);
    cloudflared.once('exit', onExit);
    cloudflared.once('error', onError);
  });

  try {
    const publicUrl = await waitForUrl;
    return { proc: cloudflared, publicUrl };
  } catch (error) {
    await killProcessTree(cloudflared);
    throw error;
  }
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
  const usePrivateMode = options.private ?? false;
  const shutdownState = { shuttingDown: false };
  const processes: ProcessRecord[] = [];
  let authProxyClose: (() => Promise<void>) | null = null;
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

    if (authProxyClose) {
      try {
        await authProxyClose();
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

  const databasePath = getDefaultDatabasePath();
  ensureDataDir(databasePath);
  try {
    runMigrations(projectRoot, databasePath);
  } catch (error) {
    console.error(chalk.red(`\n❌ Migration failed: ${(error as Error).message}`));
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

  let targetPort = backend.port;
  let password: string | null = null;
  let directToken: string | null = null;

  if (usePrivateMode) {
    password = generatePassword();
    directToken = generateMagicToken();

    let authProxy: { port: number; close: () => Promise<void> };
    try {
      authProxy = await createAuthProxy({
        upstreamPort: backend.port,
        password,
        magicToken: directToken,
      });
    } catch (error) {
      await shutdown(1, `❌ ${(error as Error).message}`);
      return;
    }

    targetPort = authProxy.port;
    authProxyClose = authProxy.close;
  }

  console.log(chalk.blue('Starting tunnel...'));

  let tunnel: { proc: ChildProcess; publicUrl: string };
  try {
    tunnel = await startCloudflaredTunnel(`http://${LOCAL_HOST}:${targetPort}`);
  } catch (error) {
    await shutdown(1, `❌ ${(error as Error).message}`);
    return;
  }

  processes.push({ name: 'cloudflared', proc: tunnel.proc });

  if (usePrivateMode && password && directToken) {
    console.log(chalk.green(`🌍 Public URL:  ${tunnel.publicUrl}`));
    console.log(chalk.green(`🔑 Password:   ${password}`));
    console.log(chalk.green(`🔗 Direct link: ${tunnel.publicUrl}?token=${directToken}\n`));
    console.log('Share the password or direct link with people you want to grant access.');
    console.log('Press Ctrl+C to stop.');
  } else {
    console.log(chalk.green(`🌍 Public URL:  ${tunnel.publicUrl}\n`));
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
  parseCookieHeader,
  signValue,
  verifySessionValue,
};
