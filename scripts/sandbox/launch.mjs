// Starts one sandbox: creates and records its directory, starts the egress
// recorder, runs `ff serve --dev` in its own process group, seeds it, and tears
// everything down on a signal, server exit, owner exit or time-out.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startEgressRecorder } from './egress.mjs';
import { buildServerEnv } from './env.mjs';
import { assertInsideTempDir, sandboxPaths, sandboxRoot } from './paths.mjs';
import { findFreePort } from './ports.mjs';
import { checkScenario, createSeedRepository, prepareSandbox } from './prepare.mjs';
import { findProcess, ownIdentity, realSystem } from './process-group.mjs';
import { createSandboxDirectory, readSandboxRecord, writeSandboxRecord } from './record.mjs';
import { seed } from './seed.mjs';
import { signalOwnServerGroup, startServer, stopServer, tail, waitForServer } from './server.mjs';
import { startWatchdog } from './watchdog.mjs';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
export const MAX_PORT_ATTEMPTS = 3;

const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @typedef {object} LaunchDependencies
 * @property {string} [root]
 * @property {string} [tempDir]
 * @property {NodeJS.ProcessEnv} [parentEnv]
 * @property {import('./process-group.mjs').ProcessSystem} [system]
 * @property {(command: string, args: string[], options: object) => any} [spawnImpl]
 * @property {() => Promise<number>} [findPort]
 * @property {(signal: string, handler: () => void) => unknown} [onSignal]
 * @property {(text: string) => unknown} [log]
 * @property {(text: string) => unknown} [print]
 * @property {number} [startupTimeoutMs]
 * @property {(target: number, signal: string) => unknown} [kill]
 */

/**
 * Runs one sandbox until it stops; resolves with the launcher's exit code.
 * Every effect on the outside world is injectable for tests.
 *
 * @param {{ scenario: string, keep: boolean, ownerPid?: number | null, ttlMinutes?: number }} options
 * @param {LaunchDependencies} [dependencies]
 * @returns {Promise<number>}
 */
export async function run(
  { scenario, keep, ownerPid = null, ttlMinutes = 0 },
  {
    root = sandboxRoot(),
    tempDir = tmpdir(),
    parentEnv = process.env,
    system = realSystem,
    spawnImpl = spawn,
    findPort = findFreePort,
    onSignal = (signal, handler) => process.on(signal, handler),
    log = (text) => process.stderr.write(`dev-sandbox: ${text}\n`),
    print = (text) => process.stdout.write(text),
    startupTimeoutMs,
    kill = (target, signal) => process.kill(target, signal),
  } = {}
) {
  const state = { baseDir: null, recorder: null, server: null, stopping: null };
  let stopWatchdog = () => undefined;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  const stop = (reason, exitCode) => {
    state.stopping ??= (async () => {
      log(`stopping (${reason})`);
      stopWatchdog();
      let code = exitCode;
      let listingFailed = false;
      // A failure of either reading (the process table, or the environments of
      // its members) means nothing can be identified.
      const recordFailure =
        (read) =>
        (...args) => {
          try {
            return read(...args);
          } catch (error) {
            listingFailed = true;
            throw error;
          }
        };
      const watched = {
        ...system,
        listProcesses: recordFailure(system.listProcesses),
        processesWithEnvironment: recordFailure(system.processesWithEnvironment),
      };
      const keptForClean = () =>
        state.baseDir &&
        existsSync(state.baseDir) &&
        log(
          `kept ${state.baseDir}: run pnpm dev:sandbox --clean ${listingFailed ? 'once ps works' : 'to remove it'}`
        );
      try {
        let signalledBlind = false;
        try {
          await stopServer(state.server, watched, state.baseDir);
        } catch (error) {
          // Without a listing nothing can be identified (I5), except this
          // launcher's own server child while it is unreaped.
          if (
            !(listingFailed && (await signalOwnServerGroup(state.server?.child, { system, kill })))
          ) {
            throw error;
          }
          log(
            `cannot read the process table (${message(error)}); signalled the server's own group`
          );
          signalledBlind = true;
          code = 1;
        }
        await state.recorder?.close();
        if (state.baseDir && signalledBlind) {
          // Whether anything still runs with it as BASE_DIR cannot be checked.
          keptForClean();
        } else if (state.baseDir && keep) {
          log(`kept ${state.baseDir}`);
        } else if (state.baseDir) {
          assertInsideTempDir(state.baseDir, tempDir);
          rmSync(state.baseDir, { recursive: true, force: true });
        }
      } catch (error) {
        log(message(error));
        keptForClean();
        code = 1;
        // The recorder must not outlive the launcher's run on this path either.
        await state.recorder?.close().catch((closeError) => log(message(closeError)));
      }
      resolveStopped(code);
      return code;
    })();
    return state.stopping;
  };
  // Before any setup, so a signal at any point still cleans up.
  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    onSignal(signal, () => void stop(signal, code));
  }
  try {
    await setUp();
  } catch (error) {
    if (state.stopping) {
      return state.stopping;
    }
    if (!state.baseDir) {
      throw error;
    }
    log(`startup failed: ${message(error)}`);
    log(`server output:\n${tail(sandboxPaths(state.baseDir).serverOutput)}`);
    return stop('startup failed', 1);
  }
  // Ready, or stopping; either way the sandbox lives until stop() finishes.
  return stopped;

  async function setUp() {
    const processes = system.listProcesses();
    const owner = ownerPid === null ? null : findProcess(processes, ownerPid);
    if (ownerPid !== null && !owner) {
      throw new Error(`Owner process ${ownerPid} is not running.`);
    }
    const launcher = ownIdentity(system);
    if (state.stopping) {
      return;
    }
    mkdirSync(root, { recursive: true });
    assertInsideTempDir(root, tempDir);
    state.baseDir = createSandboxDirectory(root, launcher, scenario);
    assertInsideTempDir(state.baseDir, tempDir);
    const paths = sandboxPaths(state.baseDir);
    const record = readSandboxRecord(paths.sandboxJson);
    const save = () => writeSandboxRecord(paths.sandboxJson, record);
    stopWatchdog = startWatchdog({
      owner: owner && { pid: owner.pid, startedAt: owner.startedAt },
      ttlMinutes,
      startedAtMs: system.now(),
      system,
      onExpire: (reason) => void stop(reason, 0),
    });

    prepareSandbox(state.baseDir);
    state.recorder = await startEgressRecorder({ logFile: paths.egressLog });
    record.egressPort = state.recorder.port;
    save();
    if (state.stopping) {
      return;
    }
    const env = buildServerEnv({
      parentEnv,
      baseDir: state.baseDir,
      scenario,
      egressPort: state.recorder.port,
    });
    checkScenario(env.CODEX_PATH, env);
    createSeedRepository(paths, env);

    let lastMismatch = '';
    for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
      const frontend = await findPort();
      if (state.stopping) {
        return;
      }
      const backend = await findPort();
      if (state.stopping) {
        return;
      }
      if (backend === frontend) {
        lastMismatch = `port discovery returned ${frontend} twice`;
        log(`attempt ${attempt}: ${lastMismatch}; retrying with fresh ports`);
        continue;
      }
      rmSync(paths.portFile, { force: true });
      const server = startServer({
        paths,
        env,
        ports: { frontend, backend },
        spawnImpl,
        onExit: (code, signal) => {
          if (!server.retiring) {
            void stop(`server exited with ${signal ?? `code ${code}`}`, 1);
          }
        },
        onError: (error) => void stop(`the server could not be started: ${message(error)}`, 1),
      });
      // A detached child's pid is its group ID: record it before anything else
      // (a SIGKILL from here on still leaves the group findable), then add the
      // leader's start time once read. Unreaped, the pid cannot be reused yet.
      state.server = server.child.pid
        ? { pgid: server.child.pid, startedAt: null, child: server.child }
        : null;
      record.pgid = state.server?.pgid ?? null;
      record.pgidStartedAt = null;
      save();
      const leader = state.server ? findProcess(system.listProcesses(), state.server.pgid) : null;
      if (state.server && leader) {
        state.server.startedAt = leader.startedAt;
        record.pgidStartedAt = leader.startedAt;
        save();
      }
      const result = await waitForServer({
        paths,
        server,
        requested: { frontend, backend },
        system,
        timeoutMs: startupTimeoutMs,
      });
      if (state.stopping) {
        return;
      }
      if (result.status === 'ready') {
        record.backendUrl = `http://localhost:${backend}`;
        record.frontendUrl = `http://localhost:${frontend}`;
        record.projectId = await seed(record.backendUrl, paths.repoPath);
        if (state.stopping) {
          return;
        }
        save();
        print(`SANDBOX_READY ${paths.sandboxJson}\n`);
        return;
      }
      // Another process took a port between probing and binding: discard this attempt.
      lastMismatch = result.message;
      log(`attempt ${attempt}: ${result.message}; retrying with fresh ports`);
      server.retiring = true;
      await stopServer(state.server, system, state.baseDir);
      state.server = null;
      record.pgid = null;
      record.pgidStartedAt = null;
      save();
    }
    throw new Error(
      `The server could not start on fresh ports in ${MAX_PORT_ATTEMPTS} attempts (last: ${lastMismatch}).`
    );
  }
}
