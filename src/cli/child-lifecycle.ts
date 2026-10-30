import type { ChildProcess } from 'node:child_process';
import chalk from 'chalk';
import { treeKillAsync } from './runtime-utils';

export function watchChild(child: ChildProcess, name: string) {
  let dispose = () => {
    /* Replaced synchronously when listeners are installed. */
  };
  const exited = new Promise<Error>((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      resolve(new Error(`${name} exited (code: ${code}, signal: ${signal}).`));
    };
    const onError = (error: Error) => resolve(new Error(`${name}: ${error.message}`));
    child.once('exit', onExit);
    child.once('error', onError);
    dispose = () => {
      child.off('exit', onExit);
      child.off('error', onError);
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
  return { exited, dispose };
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  let dispose = () => {
    /* Replaced when termination listeners are installed. */
  };
  const terminated = new Promise<boolean>((resolve) => {
    const onExit = () => resolve(true);
    const onError = (error: Error) => {
      console.error(chalk.yellow(`Child ${child.pid} shutdown error: ${error.message}`));
    };
    child.once('exit', onExit);
    child.once('close', onExit);
    child.on('error', onError);
    dispose = () => {
      child.off('exit', onExit);
      child.off('close', onExit);
      child.off('error', onError);
    };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await treeKillAsync(child.pid, 'SIGTERM');
    } catch (error) {
      console.error(chalk.yellow(`Could not send SIGTERM to child ${child.pid}: ${String(error)}`));
    }
    const stopped = await Promise.race([
      terminated,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
        timer.unref();
      }),
    ]);
    if (!stopped) {
      await treeKillAsync(child.pid, 'SIGKILL');
    }
  } catch (error) {
    console.error(chalk.yellow(`Could not stop child ${child.pid}: ${String(error)}`));
  } finally {
    clearTimeout(timer);
    dispose();
  }
}
