import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const cli = fileURLToPath(import.meta.resolve('storybook/internal/bin/dispatcher'));
const start = performance.now();
const child = spawn(
  process.execPath,
  [cli, 'dev', '--port', '6029', '--ci', '--no-open', '--quiet'],
  {
    cwd: process.argv[2] ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
child.stdout.on('data', (data) => process.stderr.write(data));
child.stderr.on('data', (data) => process.stderr.write(data));
let spawnFailure;
child.on('error', (error) => {
  spawnFailure = error;
});
function waitForExit(timeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Timed out waiting for Storybook to exit'));
    }, timeout);
    child.once('exit', onExit);
  });
}
async function stopStorybook() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const stopped = waitForExit(5000);
  child.kill('SIGTERM');
  try {
    await stopped;
  } catch {
    const killed = waitForExit(2000);
    child.kill('SIGKILL');
    await killed;
  }
}
let browser;
try {
  const deadline = performance.now() + 60_000;
  let ready = false;
  while (performance.now() < deadline) {
    if (spawnFailure) {
      throw spawnFailure;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Storybook exited before becoming ready');
    }
    try {
      ready = (await fetch('http://127.0.0.1:6029/', { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* The development server may not accept connections yet. */
    }
    if (ready) {
      break;
    }
    await delay(100);
  }
  if (!ready) {
    throw new Error('Storybook did not become ready within 60 seconds');
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
  try {
    await browser?.close();
  } finally {
    await stopStorybook();
  }
}
