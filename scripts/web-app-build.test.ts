// @vitest-environment jsdom

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';

it.each([
  ['./', '', '/'],
  ['./', '/machine/example/api/port/3000/', '/machine/example/api/port/3000/'],
  ['/factory/', '', '/factory/'],
])(
  'keeps installation URLs stable on deep routes (asset base %s, app base %s)',
  async (base, appBase, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'ff-web-app-build-'));
    vi.stubEnv('VITE_BASE_PATH', base);
    vi.stubEnv('VITE_WEB_APP_BASE_PATH', appBase);
    try {
      const html = await readFile(resolve('index.html'), 'utf8');
      // Build the real HTML metadata without bundling the application in this contract test.
      await writeFile(
        join(root, 'index.html'),
        html.replace(/<script type="module"[^>]*><\/script>/, '')
      );
      await build({
        configFile: resolve('vite.config.ts'),
        root,
        publicDir: false,
        logLevel: 'silent',
        build: { outDir: join(root, 'output') },
      });
      const output = await readFile(join(root, 'output/index.html'), 'utf8');
      const document = new DOMParser().parseFromString(output, 'text/html');
      const documentBase = document.createElement('base');
      documentBase.href = `https://host.ts.net${expected}projects/repo/agents`;
      document.head.prepend(documentBase);
      expect(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href).toBe(
        `https://host.ts.net${expected}manifest.webmanifest`
      );
      expect(document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href).toBe(
        `https://host.ts.net${expected}icons/apple-touch-icon.png`
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
