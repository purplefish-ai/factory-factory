import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const cli = fileURLToPath(import.meta.resolve('storybook/internal/bin/dispatcher'));
const start = performance.now();
const child = spawn(
  process.execPath,
  [cli, 'dev', '--port', '6029', '--ci', '--no-open', '--quiet'],
  { cwd: process.argv[2] ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
);
child.stdout.on('data', (d) => process.stderr.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
let browser;
try {
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch('http://127.0.0.1:6029/')).ok) {
        break;
      }
    } catch {
      /* Retry until the development server accepts connections. */
    }
    await setTimeout(100);
  }
  const readyMs = performance.now() - start;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(90_000);
  const navigation = performance.now();
  await page.goto(
    'http://127.0.0.1:6029/iframe.html?id=workspace-fileviewer--accessible-monospace-font&viewMode=story'
  );
  await page.getByText('greeting', { exact: true }).first().waitFor();
  console.log(
    JSON.stringify({
      tag: process.argv[3],
      readyMs,
      firstStoryMs: performance.now() - navigation,
      totalMs: performance.now() - start,
    })
  );
} finally {
  await browser?.close();
  child.kill('SIGTERM');
}
