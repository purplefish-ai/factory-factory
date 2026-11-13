// Starts one sandbox: prepares its directory, runs `ff serve --dev` in its own
// process group, seeds it, and tears everything down on a signal or server exit.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildServerEnv } from './env.mjs';
import { assertInsideTempDir, REPO_ROOT, sandboxRoot } from './paths.mjs';
import { findFreePort, parseBackendPort, parsePortFile } from './ports.mjs';
import { checkScenario, createSeedRepository, prepareSandbox } from './prepare.mjs';
import { realSystem, stopProcessGroup } from './process-group.mjs';
import { writeSandboxRecord } from './record.mjs';
import { seed } from './seed.mjs';

const STARTUP_TIMEOUT_MS = 180_000;

async function waitForReady(paths, getBackendPort, hasExited) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error('The server exited during startup.');
    }
    const backendPort = getBackendPort();
    const frontendPort = existsSync(paths.portFile)
      ? parsePortFile(readFileSync(paths.portFile, 'utf8'))
      : null;
    if (backendPort && frontendPort) {
      return { backendPort, frontendPort };
    }
    await realSystem.sleep(250);
  }
  throw new Error(`The server was not ready within ${STARTUP_TIMEOUT_MS / 1000} seconds.`);
}

function tail(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '';
  }
}

export async function run({ scenario, keep }) {
  const log = (message) => process.stderr.write(`dev-sandbox: ${message}\n`);
  const root = sandboxRoot();
  mkdirSync(root, { recursive: true });
  assertInsideTempDir(root);
  const baseDir = realpathSync(mkdtempSync(join(root, 'sb-')));
  assertInsideTempDir(baseDir);
  const env = buildServerEnv({ parentEnv: process.env, baseDir, scenario });
  let paths;
  let frontendPort;
  let backendPort;
  try {
    paths = prepareSandbox(baseDir);
    checkScenario(env.CODEX_PATH, env);
    createSeedRepository(paths, env);
    [frontendPort, backendPort] = [await findFreePort(), await findFreePort()];
  } catch (error) {
    rmSync(baseDir, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'src', 'cli', 'bootstrap.mjs'),
      'serve',
      '--dev',
      '--no-open',
      '--port',
      String(frontendPort),
      '--backend-port',
      String(backendPort),
    ],
    // cwd is the sandbox, so `ff serve` writes its port file there and loads no .env.
    { cwd: baseDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const pgid = child.pid;
  let exited = false;
  // The backend reports its port once; keep only enough output to find that line.
  let pendingOutput = '';
  let reportedBackendPort = null;
  child.stdout.on('data', (chunk) => {
    const output = pendingOutput + chunk.toString();
    reportedBackendPort ??= parseBackendPort(output);
    pendingOutput = output.slice(output.lastIndexOf('\n') + 1).slice(-4096);
    appendFileSync(paths.serverOutput, chunk);
  });
  child.stderr.on('data', (chunk) => appendFileSync(paths.serverOutput, chunk));

  const record = {
    baseDir,
    frontendUrl: null,
    backendUrl: null,
    pid: process.pid,
    pgid,
    projectId: null,
    repoPath: paths.repoPath,
    scenario,
  };
  writeSandboxRecord(paths.sandboxJson, record);

  let stopping = null;
  const stop = (reason, exitCode) => {
    stopping ??= (async () => {
      log(`stopping (${reason})`);
      try {
        await stopProcessGroup(pgid);
        if (keep) {
          log(`kept ${baseDir}`);
        } else {
          assertInsideTempDir(baseDir);
          rmSync(baseDir, { recursive: true, force: true });
        }
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
        exitCode = 1;
      }
      process.exit(exitCode);
    })();
    return stopping;
  };
  process.on('SIGINT', () => void stop('SIGINT', 130));
  process.on('SIGTERM', () => void stop('SIGTERM', 143));
  process.on('SIGHUP', () => void stop('SIGHUP', 129));
  child.once('exit', (code, signal) => {
    exited = true;
    void stop(`server exited with ${signal ?? `code ${code}`}`, 1);
  });

  try {
    const ports = await waitForReady(
      paths,
      () => reportedBackendPort,
      () => exited
    );
    record.backendUrl = `http://localhost:${ports.backendPort}`;
    record.frontendUrl = `http://localhost:${ports.frontendPort}`;
    record.projectId = await seed(record.backendUrl, paths.repoPath);
  } catch (error) {
    log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
    log(`server output:\n${tail(paths.serverOutput)}`);
    await stop('startup failed', 1);
    return;
  }
  if (stopping) {
    return;
  }
  writeSandboxRecord(paths.sandboxJson, record);
  process.stdout.write(`SANDBOX_READY ${paths.sandboxJson}\n`);
}
