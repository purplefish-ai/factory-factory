import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/');
await page.addScriptTag({
  type: 'module',
  content: `
  import { createElement, createRoot, flushSync, FileCode, Prism } from '/scripts/benchmarks/file-viewer-entry.ts';
  window.fileViewerBenchmark = { createElement, createRoot, flushSync, FileCode, Prism };
`,
});
await page.waitForFunction(() => Boolean(window.fileViewerBenchmark));
const result = await page.evaluate(async () => {
  const { createElement, createRoot, flushSync, FileCode, Prism } = window.fileViewerBenchmark;
  const measurements = [];
  for (const bytes of [100_000, 1_000_000]) {
    const fixture = '/* multiline comment\ncontinues here */\nexport const greeting = "hello";\n'
      .repeat(Math.ceil(bytes / 70))
      .slice(0, bytes);
    const marker = '\n// unique native find marker';
    const source = fixture.slice(0, bytes - marker.length) + marker;
    for (const [name, component, props] of [
      [
        'Prism',
        Prism,
        { children: source, language: 'typescript', showLineNumbers: true, wrapLines: true },
      ],
      [
        'FileCode',
        FileCode,
        { content: source, language: 'typescript', theme: { comment: { color: 'gray' } } },
      ],
    ]) {
      const host = document.createElement('div');
      host.style.cssText = 'height:400px;overflow:auto';
      document.body.replaceChildren(host);
      const root = createRoot(host);
      const start = performance.now();
      flushSync(() => root.render(createElement(component, props)));
      const firstRender = performance.now() - start;
      const height = host.scrollHeight;
      let scroll = null;
      if (name === 'FileCode') {
        const deadline = performance.now() + 15_000;
        while (!host.querySelector('code span[style]')) {
          if (performance.now() > deadline) {
            throw new Error('Timed out waiting for worker highlighting');
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const sourceNodes = host.querySelector('pre').cloneNode(true);
        sourceNodes.querySelectorAll('[aria-hidden]').forEach((node) => node.remove());
        if (sourceNodes.textContent !== source) {
          throw new Error('source changed');
        }
        if (!host.querySelector('code span[style]')) {
          throw new Error('worker highlighting missing');
        }
        const code = host.querySelectorAll('code');
        const range = document.createRange();
        range.setStartBefore(code[0].firstChild);
        range.setEndAfter(code[code.length - 1].lastChild);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (selection.toString() !== source) {
          throw new Error('Cross-block selection changed source');
        }
        selection.removeAllRanges();
        const phrase = 'unique native find marker';
        if (!window.find(phrase)) {
          throw new Error('Native find cannot locate offscreen source');
        }
        code[code.length - 1].scrollIntoView({ block: 'start' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (selection.toString() !== phrase) {
          throw new Error('Native find selection lost during scroll');
        }
        selection.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
        host.scrollTop = height;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const viewport = host.getBoundingClientRect();
        const visibleBlockFirstLines = [...host.querySelectorAll('pre > div')]
          .filter((block) => {
            const rect = block.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          })
          .map((block) => Number(block.querySelector('[aria-hidden]')?.textContent.split('\n')[0]));
        if (host.scrollTop <= 0 || visibleBlockFirstLines.length === 0) {
          throw new Error('Scrolling did not reveal source blocks');
        }
        scroll = { top: host.scrollTop, visibleBlockFirstLines };
      }
      measurements.push({
        bytes,
        name,
        firstRender,
        height,
        blocks: host.querySelectorAll('pre code').length,
        scroll,
      });
      root.unmount();
    }
  }
  return measurements;
});
console.log(JSON.stringify(result, null, 2));

await browser.close();
