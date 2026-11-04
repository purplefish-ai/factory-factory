import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { releaseVersionSchema } from '@/shared/application-updates';

const exec = promisify(execFile);
type Run = (command: string, args: string[], signal?: AbortSignal) => Promise<string>;
interface Options {
  packageRoot: string;
  env: NodeJS.ProcessEnv;
  run?: Run;
  platform?: NodeJS.Platform;
  onStage?: (recoveryPath: string) => Promise<void>;
  ownedProcessIds?: () => number[];
}
const packageSchema = z.object({
  name: z.literal('factory-factory'),
  version: releaseVersionSchema,
});

export async function hasOtherApplicationServers(
  packageRoot: string,
  ownedProcessIds: number[] = []
): Promise<boolean> {
  const entries = await readdir(dirname(packageRoot));
  return entries.some((entry) => {
    const match = /^\.factory-factory-running-(\d+)$/.exec(entry);
    if (!match || Number(match[1]) === process.pid || ownedProcessIds.includes(Number(match[1]))) {
      return false;
    }
    try {
      process.kill(Number(match[1]), 0);
      return true;
    } catch (error) {
      return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
  });
}

/** Owns a replacement on the installation's volume; never mutates the live app during preparation. */
export class ApplicationUpdateInstaller {
  private readonly run: Run;
  constructor(private readonly options: Options) {
    this.run =
      options.run ??
      (async (command, args, signal) => {
        const { stdout } = await exec(command, args, {
          env: options.env,
          signal,
          timeout: 600_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return stdout.trim();
      });
  }

  async isSupported(): Promise<boolean> {
    if ((this.options.platform ?? process.platform) === 'win32') {
      return false;
    }
    try {
      const root = this.options.packageRoot;
      const globalRoot = await this.run('npm', ['root', '--global']);
      if ((await lstat(root)).isSymbolicLink()) {
        return false;
      }
      if ((await realpath(join(globalRoot, 'factory-factory'))) !== (await realpath(root))) {
        return false;
      }
      await access(dirname(root), constants.W_OK);
      packageSchema.parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
      return true;
    } catch {
      return false;
    }
  }

  async prepare(version: string, signal: AbortSignal) {
    releaseVersionSchema.parse(version);
    if (!(await this.isSupported())) {
      throw new Error('This installation requires a manual update.');
    }
    signal.throwIfAborted();
    const root = this.options.packageRoot;
    const lock = join(dirname(root), '.factory-factory-update-lock');
    try {
      await mkdir(lock);
    } catch {
      throw new Error('Another update owns the installation lock.');
    }
    let stage: string;
    try {
      stage = await mkdtemp(join(dirname(root), '.factory-factory-update-'));
    } catch (error) {
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
    const candidate = join(stage, 'lib/node_modules/factory-factory');
    const backup = join(stage, 'previous');
    let activated = false;
    try {
      await this.options.onStage?.(backup);
      if (await hasOtherApplicationServers(root, this.options.ownedProcessIds?.())) {
        throw new Error('Close other Factory Factory servers before updating this installation.');
      }
      const installed = packageSchema.parse(
        JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      );
      const current = installed.version.split('.').map(Number);
      const available = version.split('.').map(Number);
      const difference =
        available.map((part, index) => part - (current[index] ?? 0)).find((part) => part !== 0) ??
        0;
      if (difference <= 0) {
        throw new Error('The requested release is no newer than the installed version.');
      }
      await this.run(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          stage,
          `factory-factory@${version}`,
          '--registry=https://registry.npmjs.org',
          '--no-audit',
          '--no-fund',
        ],
        signal
      );
      signal.throwIfAborted();
      const pkg = packageSchema.parse(
        JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
      );
      if (pkg.version !== version) {
        throw new Error('Downloaded release version does not match the requested version.');
      }
      await Promise.all(
        ['dist/src/backend/index.js', 'dist/src/cli/index.js', 'dist/client/index.html'].map(
          (file) => access(join(candidate, file))
        )
      );
      // Exercise the packaged entrypoint and its native dependency before stopping the old backend.
      await this.run(
        process.execPath,
        [join(candidate, 'dist/src/cli/index.js'), '--version'],
        signal
      );
      const nativeProbe =
        "const {createRequire}=require('node:module');const r=createRequire(process.argv[1]);const DB=r('better-sqlite3');const db=new DB(':memory:');db.close();r('node-pty');";
      await this.run(
        process.execPath,
        ['-e', nativeProbe, join(candidate, 'package.json')],
        signal
      );
      return {
        packageRoot: root,
        async activate() {
          signal.throwIfAborted();
          await rename(root, backup);
          try {
            await rename(candidate, root);
            activated = true;
          } catch (error) {
            await rename(backup, root);
            throw error;
          }
        },
        async rollback() {
          if (!activated) {
            return;
          }
          await rename(root, candidate);
          try {
            await rename(backup, root);
            activated = false;
          } catch (error) {
            await rename(candidate, root);
            throw error;
          }
        },
        async dispose() {
          await rm(stage, { recursive: true, force: true });
          await rm(lock, { recursive: true, force: true });
        },
        recoveryPath: backup,
      };
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
  }
}
export type PreparedApplicationUpdate = Awaited<ReturnType<ApplicationUpdateInstaller['prepare']>>;
