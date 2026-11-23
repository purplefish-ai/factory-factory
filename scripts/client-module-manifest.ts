import { realpathSync } from 'node:fs';
import { posix, relative } from 'node:path';
import { normalizePath, type Plugin } from 'vite';

function projectSourceModules(ids: string[], roots: ReadonlySet<string>) {
  const sources = new Set<string>();
  for (const id of ids) {
    for (const root of roots) {
      const source = normalizePath(relative(root, id.replace(/\?.*$/, '')));
      if (source.startsWith('src/')) {
        sources.add(source);
        break;
      }
    }
  }
  return [...sources].sort();
}

/** Package names only: a chunk's dependencies without their versions or install paths. */
function packageNames(ids: string[]) {
  const packages = new Set<string>();
  for (const id of ids) {
    const path = normalizePath(id.replace(/\?.*$/, ''));
    const index = path.lastIndexOf('/node_modules/');
    if (index === -1) {
      continue;
    }
    const [scopeOrName, name] = path.slice(index + '/node_modules/'.length).split('/');
    if (scopeOrName) {
      packages.add(scopeOrName.startsWith('@') && name ? `${scopeOrName}/${name}` : scopeOrName);
    }
  }
  return [...packages].sort();
}

/**
 * Preserve source and package identity after bundling merges viewers into entry/shared
 * chunks or folds a library into a chunk named after something else.
 */
export function clientModuleManifest(): Plugin {
  const roots = new Set<string>();
  let assetsDirectory = 'assets';
  return {
    name: 'client-module-manifest',
    apply: 'build',
    configResolved(config) {
      roots.add(config.root);
      roots.add(realpathSync(config.root));
      assetsDirectory = config.build.assetsDir;
    },
    generateBundle(_options, bundle) {
      const modules: Record<string, string[]> = {};
      const packages: Record<string, string[]> = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') {
          continue;
        }
        const chunk = normalizePath(relative(assetsDirectory, output.fileName));
        const ids = Object.keys(output.modules);
        modules[chunk] = projectSourceModules(ids, roots);
        packages[chunk] = packageNames(ids);
      }
      // Only repository-relative source paths and package names; omit source content and machine paths.
      this.emitFile({
        type: 'asset',
        fileName: posix.join(normalizePath(assetsDirectory), 'client-modules.json'),
        source: JSON.stringify({ version: 2, modules, packages }),
      });
    },
  };
}
