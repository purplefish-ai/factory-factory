import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

// Render the approved vector artwork with browser-accurate SVG gradients.
// Requires ImageMagick 7 and Playwright's Chromium, or --channel=chrome.
const { values } = parseArgs({ options: { channel: { type: 'string' } } });
const source = new URL('../public/social-preview.svg', import.meta.url);
const destination = new URL('../public/social-preview.png', import.meta.url);
const svg = readFileSync(source, 'utf8');
const browser = await chromium.launch({ channel: values.channel, headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 2,
  });
  await page.setContent(`<!doctype html>
    <html><head><style>
      html, body { margin: 0; width: 1280px; height: 640px; overflow: hidden; }
      svg { display: block; }
    </style></head><body>${svg}</body></html>`);
  const pixels = await page.screenshot({ type: 'png' });
  const png = execFileSync('magick', ['png:-', '-resize', '1280x640!', '-strip', 'PNG24:-'], {
    input: pixels,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (png.length >= 1_000_000) {
    throw new Error('Social preview must stay under GitHub’s 1 MB upload limit.');
  }
  writeFileSync(destination, png);
  console.log(fileURLToPath(destination));
} finally {
  await browser.close();
}
