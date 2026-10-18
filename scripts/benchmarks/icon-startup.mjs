import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const cacheDir = mkdtempSync(join(tmpdir(), 'ff-icons-vite-'));
const start = performance.now();
const server = await createServer({ cacheDir, server: { port: 5190, host: '127.0.0.1' } });
await server.listen();
const serverReadyMs = performance.now() - start;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(90_000);
  let requests = 0;
  page.on('request', () => requests++);
  const navigation = performance.now();
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForSelector('svg');
  console.log(
    JSON.stringify({
      tag: process.argv[2],
      serverReadyMs,
      firstSvgMs: performance.now() - navigation,
      requests,
    })
  );
} finally {
  await browser.close();
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
}
