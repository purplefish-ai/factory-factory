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
    const source = '/* multiline comment\ncontinues here */\nexport const greeting = "hello";\n'
      .repeat(Math.ceil(bytes / 70))
      .slice(0, bytes);
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
      if (name === 'FileCode') {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const sourceNodes = host.querySelector('pre').cloneNode(true);
        sourceNodes.querySelectorAll('[aria-hidden]').forEach((node) => node.remove());
        if (sourceNodes.textContent !== source) {
          throw new Error('source changed');
        }
        if (!host.querySelector('code span[style]')) {
          throw new Error('worker highlighting missing');
        }
        host.scrollTop = height;
      }
      measurements.push({
        bytes,
        name,
        firstRender,
        height,
        blocks: host.querySelectorAll('pre code').length,
      });
      root.unmount();
    }
  }
  return measurements;
});
console.log(JSON.stringify(result, null, 2));

await browser.close();
