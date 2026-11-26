// Keep this module free of application dependencies: it must run on older Node.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * @typedef {{ platform: string, interactive: boolean,
 * print: (message: string) => void, ask: (question: string) => Promise<string>,
 * probe: (command: string, args: string[]) => Promise<boolean>,
 * run: (command: string, args: string[]) => Promise<boolean> }} SetupIO
 */

// The package declares a stable minimum, optionally with an earlier LTS line.
// Keep this grammar small so even unsupported Node can show setup instructions.
/** @param {string} requirement */
export function nodeFloors(requirement) {
  const match = /^(?:\^(\d+\.\d+\.\d+) \|\| )?>=(\d+\.\d+\.\d+)$/.exec(requirement);
  if (!match) {
    throw new Error(
      'The installation has an invalid Node.js requirement. Reinstall Factory Factory.'
    );
  }
  return { lts: match[1], minimum: match[2] };
}

/** @param {string} version @param {string} floor */
function atLeast(version, floor) {
  const current = version.split('.').map(Number);
  const required = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== required[i]) {
      return current[i] > required[i];
    }
  }
  return true;
}

/** @param {string} version @param {string} requirement */
export function supportsNode(version, requirement) {
  const { lts, minimum } = nodeFloors(requirement);
  const release =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.exec(
      version
    );
  if (!release) {
    return false;
  }
  const current = release[1];
  return (
    atLeast(current, minimum) ||
    Boolean(lts && current.split('.')[0] === lts.split('.')[0] && atLeast(current, lts))
  );
}

/** @param {string} command @param {string[]} args @param {boolean} visible */
function execute(command, args, visible) {
  return new Promise((resolve) => {
    const grouped = visible && process.platform !== 'win32';
    let child;
    let cancelled = 0;
    let forceStop;
    const terminate = (signal) => {
      if (!child?.pid) {
        return;
      }
      try {
        if (grouped) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The child may have exited between observing it and sending the signal.
      }
    };
    const stop = (signal, code) => {
      // A terminal signal can reach both the launcher and this process.
      // Keep the first grace period even when the launcher forwards it again.
      if (cancelled) {
        return;
      }
      cancelled = code;
      terminate(signal);
      forceStop = setTimeout(() => terminate('SIGKILL'), 5000);
      forceStop.unref();
    };
    const onInterrupt = () => stop('SIGINT', 130);
    const onTerminate = () => stop('SIGTERM', 143);
    // Listen before spawning: a signal that lands after the installer starts
    // but before the listener exists would kill setup and orphan the
    // installer's process group. Listeners run on the event loop, after
    // `child` is assigned.
    if (visible) {
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
    }
    try {
      child = spawn(command, args, {
        stdio: visible ? 'inherit' : 'ignore',
        detached: grouped,
        ...(visible ? {} : { timeout: 5000 }),
      });
    } catch (error) {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      throw error;
    }
    const finish = (success) => {
      clearTimeout(forceStop);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (cancelled) {
        terminate('SIGKILL');
        process.exit(cancelled);
      }
      resolve(success);
    };
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

/**
 * @param {{ input?: import('node:stream').Readable & { isTTY?: boolean },
 * output?: import('node:stream').Writable & { isTTY?: boolean } }} [streams]
 * @returns {SetupIO}
 */
export function createSetupIO({ input = process.stdin, output = process.stdout } = {}) {
  return {
    platform: process.platform,
    interactive: Boolean(input.isTTY && output.isTTY),
    print: (message) => process.stderr.write(`  ${message}\n`),
    probe: (command, args) => execute(command, args, false),
    run: (command, args) => execute(command, args, true),
    ask: (question) =>
      new Promise((resolve) => {
        const terminal = createInterface({ input, output });
        terminal.once('close', () => resolve(''));
        terminal.once('SIGINT', () => {
          terminal.close();
          process.exit(130);
        });
        terminal.question(question, (answer) => {
          // Resolve before closing: close also fires on EOF.
          resolve(answer);
          terminal.close();
        });
      }),
  };
}

/** @param {string[]} command @param {SetupIO} io */
export async function confirmFix(command, io) {
  const [executable, ...args] = command;
  io.print(`Fix: ${command.join(' ')}`);
  if (!io.interactive || !executable) {
    return false;
  }
  try {
    const answer = await io.ask('  Run this command? [y/N] ');
    if (!/^(y|yes)$/i.test(answer.trim())) {
      return false;
    }
    if (await io.run(executable, args)) {
      return true;
    }
    io.print('The command failed. Run the fix manually, then retry serve.');
  } catch {
    io.print('Setup was cancelled or failed. Run the fix manually, then retry serve.');
  }
  return false;
}

/** @param {'node' | 'git' | 'gh'} tool @param {SetupIO} io */
async function installation(tool, io) {
  if (io.platform === 'win32') {
    if (await io.probe('winget', ['--version'])) {
      const packages = { node: 'OpenJS.NodeJS', git: 'Git.Git', gh: 'GitHub.cli' };
      return ['winget', 'install', '--exact', '--id', packages[tool]];
    }
  } else if (await io.probe('brew', ['--version'])) {
    return ['brew', 'install', tool];
  }
  return undefined;
}

/** @param {string} version @param {string} requirement @param {SetupIO} io */
export async function ensureNode(version, requirement, io = createSetupIO()) {
  if (supportsNode(version, requirement)) {
    return true;
  }
  const { minimum } = nodeFloors(requirement);
  io.print(`Node.js ${version} is unsupported. Factory Factory requires Node.js ${requirement}.`);
  const fnm = await io.probe('fnm', ['--version']);
  const command = fnm ? ['fnm', 'install', minimum] : await installation('node', io);
  if (command) {
    await confirmFix(command, io);
  }
  io.print(`Install or activate a supported Node.js version: https://nodejs.org/en/download`);
  if (fnm) {
    io.print(`Activate it with: fnm use ${minimum}`);
  }
  io.print('Open a new terminal if needed, verify with node --version, then rerun serve.');
  // An installer cannot change the runtime of this process, or rebuild its native modules.
  return false;
}

/** @param {'git' | 'gh'} tool @param {SetupIO} io */
async function ensureTool(tool, io) {
  if (await io.probe(tool, ['--version'])) {
    return true;
  }
  const url = tool === 'git' ? 'https://git-scm.com/downloads' : 'https://cli.github.com/';
  io.print(
    `${tool === 'git' ? 'Git is required' : 'GitHub CLI is optional'} but could not be run. Install it: ${url}`
  );
  const command = await installation(tool, io);
  if (command && (await confirmFix(command, io)) && (await io.probe(tool, ['--version']))) {
    return true;
  }
  io.print(
    `Could not verify ${tool}. Check your PATH (a new terminal may be needed).${tool === 'git' ? ' Then retry serve.' : ' Continuing without GitHub integration.'}`
  );
  return false;
}

/** @param {SetupIO} io */
export async function ensureServeTools(io = createSetupIO()) {
  if (!(await ensureTool('git', io))) {
    return false;
  }
  if (await ensureTool('gh', io)) {
    const authArgs = ['auth', 'status', '--active'];
    if (!(await io.probe('gh', authArgs))) {
      io.print(
        'GitHub authentication is unavailable. GitHub issues and pull requests need gh auth login.'
      );
      if ((await confirmFix(['gh', 'auth', 'login'], io)) && !(await io.probe('gh', authArgs))) {
        io.print('GitHub authentication is still unavailable. Retry gh auth login when ready.');
      }
    }
  }
  return true;
}
