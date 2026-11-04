// Keep this module free of application dependencies: it must run on older Node.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * @typedef {{ platform: string, interactive: boolean,
 * print: (message: string) => void, ask: (question: string) => Promise<string>,
 * probe: (command: string, args: string[]) => Promise<boolean>,
 * run: (command: string, args: string[]) => Promise<boolean> }} SetupIO
 */

/** @param {string} version @param {string} minimum */
export function supportsNode(version, minimum) {
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const required = /^(\d+)\.(\d+)\.(\d+)$/.exec(minimum);
  if (!actual || !required) {
    return false;
  }
  for (let i = 1; i <= 3; i++) {
    const difference = Number(actual[i]) - Number(required[i]);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

/** @param {string} command @param {string[]} args @param {boolean} visible */
function execute(command, args, visible) {
  return new Promise((resolve) => {
    const grouped = visible && process.platform !== 'win32';
    const child = spawn(command, args, {
      stdio: visible ? 'inherit' : 'ignore',
      detached: grouped,
      ...(visible ? {} : { timeout: 5000 }),
    });
    let cancelled = 0;
    let forceStop;
    const terminate = (signal) => {
      if (!child.pid) {
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
    if (visible) {
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
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

/** @param {string} version @param {string} minimum @param {SetupIO} io */
export async function ensureNode(version, minimum, io = createSetupIO()) {
  if (supportsNode(version, minimum)) {
    return true;
  }
  io.print(
    `Node.js ${version} is unsupported. Factory Factory requires Node.js ${minimum} or newer.`
  );
  const fnm = await io.probe('fnm', ['--version']);
  const command = fnm ? ['fnm', 'install', minimum] : await installation('node', io);
  if (command) {
    await confirmFix(command, io);
  }
  io.print(`Install or activate Node.js ${minimum} or newer: https://nodejs.org/en/download`);
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
