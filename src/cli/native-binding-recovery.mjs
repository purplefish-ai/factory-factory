// Recovery is printed only after a confirmed binding failure. No repair is executed here.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const windows = process.platform === 'win32';

// All probes have fixed arguments, including when cmd.exe must start npm.cmd.
function npmOutput(args) {
  const result = spawnSync(windows ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8',
    timeout: 5000,
    shell: windows,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function quote(value) {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", windows ? "''" : "'\\''")}'`;
}

function canonical(path) {
  try {
    return isAbsolute(path) ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function cacheInstall(root, cache, require) {
  const entry = dirname(dirname(root));
  const key = basename(entry);
  // Compare real directories at every boundary. An npm-like path alone cannot authorize eviction.
  if (
    !cache ||
    !/^[a-f0-9]{16}$/.test(key) ||
    dirname(entry) !== join(cache, '_npx') ||
    root !== join(entry, 'node_modules', 'factory-factory')
  ) {
    return undefined;
  }
  const z = require('zod');
  const manifest = z
    .object({
      dependencies: z.object({ 'factory-factory': z.string() }).strict(),
      _npx: z.object({ packages: z.tuple([z.string()]) }).optional(),
    })
    .safeParse(require(join(entry, 'package.json')));
  if (!manifest.success) {
    return undefined;
  }
  const [spec] = manifest.data._npx?.packages ?? [];
  if (!spec) {
    // Older npm releases do not record the original invocation.
    return { key };
  }
  if (createHash('sha512').update(spec).digest('hex').slice(0, 16) !== key) {
    return undefined;
  }
  if (/^factory-factory(?:@[a-zA-Z0-9.+^~*-]+)?$/.test(spec)) {
    return { key, spec };
  }
  const tarball = spec.replace(/^file:/, '');
  const saved = manifest.data.dependencies['factory-factory'];
  if (
    isAbsolute(tarball) &&
    tarball.endsWith('.tgz') &&
    saved.startsWith('file:') &&
    canonical(resolve(entry, saved.slice(5))) === canonical(tarball) &&
    canonical(tarball)
  ) {
    return { key, spec };
  }
  return undefined;
}

export function bindingRecovery(packageRoot, args) {
  const root = realpathSync(packageRoot);
  const require = createRequire(join(root, 'package.json'));
  const { name, version } = require('./package.json');
  if (name !== 'factory-factory' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)) {
    return 'Reinstall Factory Factory with the package manager used for this installation, then rerun serve.';
  }
  const cache = canonical(npmOutput(['config', 'get', 'cache']));
  let installation;
  try {
    installation = cacheInstall(root, cache, require);
  } catch {
    // Incomplete or unreadable npm metadata cannot establish the identity of an entry.
  }
  if (installation) {
    const { key, spec } = installation;
    const launch = [
      '--package',
      spec ?? `factory-factory@${version}`,
      '--',
      'factory-factory',
      ...args,
    ]
      .map(quote)
      .join(' ');
    const shell = windows ? ' in PowerShell' : '';
    if (spec && npmOutput(['cache', '--help']).includes('npx rm')) {
      return `After the launcher exits, run${shell}:\n  npm cache npx rm ${key} --cache ${quote(cache)}\n  npm exec --cache ${quote(cache)} ${launch}`;
    }
    const freshCache = windows
      ? quote(join(tmpdir(), `ff-npx-${randomBytes(12).toString('hex')}`))
      : '"$(mktemp -d)"';
    return `Retry with a fresh private npm cache${shell}:\n  npm exec --cache ${freshCache} ${launch}`;
  }
  const globalRoot = canonical(npmOutput(['root', '--global']));
  if (globalRoot && root === join(globalRoot, 'factory-factory')) {
    return `Reinstall this global package with the current Node.js, then rerun serve:\n  npm uninstall --global factory-factory\n  npm install --global factory-factory@${version}`;
  }
  if (
    basename(dirname(root)) === 'node_modules' &&
    basename(root) === 'factory-factory' &&
    basename(dirname(dirname(dirname(root)))) !== '_npx'
  ) {
    return 'From the project that installed Factory Factory, do a clean dependency install with its package manager (for an npm project with a lockfile, run npm ci), then rerun serve.';
  }
  return 'Reinstall Factory Factory with the package manager used for this installation, then rerun serve.';
}
