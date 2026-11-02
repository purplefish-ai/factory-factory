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

/** Preserve source identity after bundling merges viewers into entry/shared chunks. */
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
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') {
          continue;
        }
        modules[normalizePath(relative(assetsDirectory, output.fileName))] = projectSourceModules(
          Object.keys(output.modules),
          roots
        );
      }
      // Only repository-relative source paths; omit source content and machine paths.
      this.emitFile({
        type: 'asset',
        fileName: posix.join(normalizePath(assetsDirectory), 'client-modules.json'),
        source: JSON.stringify({ version: 1, modules }),
      });
    },
  };
}
