import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const directory = mkdtempSync(join(tmpdir(), 'ff-webgl-trial-'));
let server;
let browser;
try {
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@xterm/xterm': '6.0.0', '@xterm/addon-webgl': '0.19.0' },
    })
  );
  const install = spawnSync('pnpm', ['install', '--ignore-scripts'], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    throw new Error(
      install.error?.message ||
        install.stderr ||
        install.stdout ||
        'Trial dependency installation failed'
    );
  }
  writeFileSync(
    join(directory, 'index.html'),
    '<html><body style="margin:0;background:#18181b"><script type="module" src="/entry.js"></script></body></html>'
  );
  writeFileSync(
    join(directory, 'entry.js'),
    "import { Terminal } from '@xterm/xterm'; import { WebglAddon } from '@xterm/addon-webgl'; import '@xterm/xterm/css/xterm.css'; window.xtermTrial = { Terminal, WebglAddon };"
  );
  server = await createServer({
    root: directory,
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.xtermTrial));
  const result = await page.evaluate(async () => {
    const { Terminal, WebglAddon } = window.xtermTrial;
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
    const row =
      '\x1b[38;5;82mPASS\x1b[0m \x1b[33mfile.ts:42\x1b[0m const result = compute(123);\r\n';
    const measurements = [];
    for (const count of [1, 4, 8]) {
      for (const mode of ['dom', 'webgl']) {
        for (let sample = 0; sample < 3; sample++) {
          const terms = [],
            addons = [],
            contexts = [];
          let error = null;
          document.body.replaceChildren();
          document.body.style.display = 'grid';
          document.body.style.gridTemplateColumns = `repeat(${count === 1 ? 1 : count === 4 ? 2 : 4}, 1fr)`;
          const init = performance.now();
          for (let i = 0; i < count; i++) {
            const host = document.createElement('div');
            host.style.cssText = 'width:100%;height:220px';
            document.body.append(host);
            const term = new Terminal({ cols: 32, rows: 14, fontSize: 12, scrollback: 1000 });
            term.open(host);
            terms.push(term);
            if (mode === 'webgl') {
              try {
                const addon = new WebglAddon();
                term.loadAddon(addon);
                addons.push(addon);
              } catch (e) {
                error = String(e);
                break;
              }
            }
          }
          const initMs = performance.now() - init;
          if (error) {
            terms.forEach((t) => t.dispose());
            measurements.push({ count, mode, sample, error });
            continue;
          }
          await Promise.all(terms.map((t) => write(t, row.repeat(20))));
          await frames();
          const usableInitMs = performance.now() - init;
          if (mode === 'webgl') {
            for (const term of terms) {
              for (const canvas of term.element.querySelectorAll('canvas')) {
                const gl = canvas.getContext('webgl2');
                if (gl) {
                  contexts.push(gl);
                }
              }
            }
          }

          let last = performance.now(),
            maxFrame = 0,
            running = true;
          function sampleFrame(time) {
            maxFrame = Math.max(maxFrame, time - last);
            last = time;
            if (running) {
              requestAnimationFrame(sampleFrame);
            }
          }
          requestAnimationFrame(sampleFrame);
          let start = performance.now();
          await Promise.all(terms.map((t) => write(t, row.repeat(6000))));
          await frames();
          const replayMs = performance.now() - start;
          start = performance.now();
          for (let burst = 0; burst < 30; burst++) {
            await Promise.all(terms.map((t) => write(t, row.repeat(50))));
          }
          await frames();
          const burstMs = performance.now() - start;
          running = false;
          const atlasBytes = addons.reduce(
            (sum, a) => sum + (a.textureAtlas?.width ?? 0) * (a.textureAtlas?.height ?? 0) * 4,
            0
          );
          const gl = contexts[0],
            ext = gl?.getExtension('WEBGL_debug_renderer_info');
          const gpu = gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
          const text = terms[0].buffer.active
            .getLine(terms[0].buffer.active.baseY + 12)
            ?.translateToString(true);
          if (text !== 'ompute(123);') {
            throw new Error('Terminal replay content changed');
          }
          terms.forEach((t) => t.dispose());
          const lostAfterDispose = contexts.filter((gl) => gl.isContextLost()).length;
          contexts.forEach((gl) => gl.getExtension('WEBGL_lose_context')?.loseContext());
          measurements.push({
            count,
            mode,
            sample,
            initMs,
            usableInitMs,
            replayMs,
            burstMs,
            maxFrame,
            atlasBytes,
            contexts: contexts.length,
            lostAfterDispose,
            gpu,
            text,
          });
          await frames();
        }
      }
    }
    return measurements;
  });
  const lifecycle = await page.evaluate(async () => {
    const { Terminal, WebglAddon } = window.xtermTrial;
    document.body.replaceChildren();
    const host = document.createElement('div');
    document.body.append(host);
    const terminal = new Terminal({ cols: 40, rows: 10 });
    terminal.open(host);
    const addon = new WebglAddon();
    let losses = 0;
    const subscription = addon.onContextLoss(() => {
      losses++;
      addon.dispose();
    });
    terminal.loadAddon(addon);
    await new Promise((resolve) => terminal.write('before loss\r\n', resolve));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const context = [...host.querySelectorAll('canvas')]
      .map((canvas) => canvas.getContext('webgl2'))
      .find(Boolean);
    if (!context) {
      throw new Error('Missing hardware WebGL context');
    }
    context.getExtension('WEBGL_lose_context').loseContext();
    await new Promise((resolve) => setTimeout(resolve, 3300));
    await new Promise((resolve) => terminal.write('fallback works', resolve));
    const fallbackText = terminal.buffer.active.getLine(1)?.translateToString(true);
    const restored = Boolean(host.querySelector('.xterm-rows'));
    subscription.dispose();
    terminal.dispose();
    if (losses !== 1 || !restored || fallbackText !== 'fallback works') {
      throw new Error('Context-loss fallback failed');
    }
    return { losses, restored, fallbackText };
  });
  const unsupportedBrowser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-webgl'],
  });
  let unsupported;
  try {
    const fallbackPage = await unsupportedBrowser.newPage();
    await fallbackPage.goto(server.resolvedUrls.local[0]);
    await fallbackPage.waitForFunction(() => Boolean(window.xtermTrial));
    unsupported = await fallbackPage.evaluate(async () => {
      const { Terminal, WebglAddon } = window.xtermTrial;
      const host = document.createElement('div');
      document.body.append(host);
      const terminal = new Terminal({ cols: 40, rows: 10 });
      terminal.open(host);
      const addon = new WebglAddon();
      let rejected = false;
      try {
        terminal.loadAddon(addon);
      } catch {
        rejected = true;
        addon.dispose();
      }
      await new Promise((resolve) => terminal.write('plain renderer works', resolve));
      const text = terminal.buffer.active.getLine(0)?.translateToString(true);
      terminal.dispose();
      if (!rejected || text !== 'plain renderer works') {
        throw new Error('Unsupported-GPU fallback failed');
      }
      return { rejected, text };
    });
  } finally {
    await unsupportedBrowser.close();
  }
  console.log(JSON.stringify({ measurements: result, lifecycle, unsupported }, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
