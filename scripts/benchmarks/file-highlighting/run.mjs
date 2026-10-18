import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build, loadConfigFromFile, mergeConfig } from 'vite';
import { workerSafeAliases } from '../../vite-worker-aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const output = await mkdtemp(join(tmpdir(), 'ff-file-highlighting-'));
let browser;
let server;

async function measureBundles() {
  const baselineRef =
    process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11) ??
    'fc30bb563ef4d0dc66ca8e30a0ea4f87b640ecd6';
  const original = execFileSync(
    'git',
    ['show', `${baselineRef}:src/client/features/workspace/file-viewer.tsx`],
    {
      cwd: repository,
      encoding: 'utf8',
    }
  );
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    join(repository, 'vite.config.ts')
  );
  assert(loaded, 'Vite config must load');
  const results = [];
  for (const variant of ['baseline', 'optimized']) {
    const outDir = join(output, variant);
    await build(
      mergeConfig(loaded.config, {
        configFile: false,
        root: repository,
        logLevel: 'warn',
        plugins:
          variant === 'baseline'
            ? [
                {
                  name: 'file-highlighting-baseline',
                  enforce: 'pre',
                  load(id) {
                    if (id === join(repository, 'src/client/features/workspace/file-viewer.tsx')) {
                      return original;
                    }
                  },
                },
              ]
            : [],
        build: { outDir, manifest: true, emptyOutDir: true },
      })
    );
    const manifest = JSON.parse(await readFile(join(outDir, '.vite/manifest.json'), 'utf8'));
    for (const entry of ['index.html', 'src/client/routes/projects/workspaces/detail.tsx']) {
      const visited = new Set();
      function visit(key) {
        if (visited.has(key)) {
          return;
        }
        assert(manifest[key], `Manifest entry ${key} must exist`);
        visited.add(key);
        for (const imported of manifest[key].imports ?? []) {
          visit(imported);
        }
      }
      visit(entry);
      const files = await Promise.all(
        [...visited].map(async (key) => {
          const data = await readFile(join(outDir, manifest[key].file));
          return { raw: data.length, gzip: gzipSync(data).length };
        })
      );
      results.push({
        variant,
        entry,
        raw: files.reduce((sum, file) => sum + file.raw, 0),
        gzip: files.reduce((sum, file) => sum + file.gzip, 0),
      });
    }
  }
  return { baselineRef, results };
}

async function verifyColdLoading(browser, origin, workerFile) {
  const url = `${origin}/loading/loading.html`;
  const scrollPage = await browser.newPage();
  const scrollOwnership = [];
  try {
    await scrollPage.goto(url, { waitUntil: 'networkidle' });
    await scrollPage.evaluate(() => window.warmHighlighting());
    for (const language of ['typescript', 'text']) {
      const result = await scrollPage.evaluate(
        (mode) => window.verifyScrollRestoration(mode),
        language
      );
      assert.equal(
        result.preOverflow,
        'visible',
        `${language}: outer viewport owns overflow (${JSON.stringify(result)})`
      );
      assert.equal(result.outerLeft, 192, `${language}: outer viewport can scroll`);
      assert.equal(result.preLeft, 0, `${language}: pre cannot independently scroll`);
      assert.equal(
        result.restoredLeft,
        192,
        `${language}: horizontal position restores after remount`
      );
      scrollOwnership.push({ language, ...result });
    }
  } finally {
    await scrollPage.close();
  }

  const plainPage = await browser.newPage();
  const grammarRequests = [];
  const plainAliases = ['text', 'plain', 'plaintext', 'txt'];
  try {
    plainPage.on('request', (request) => {
      if (request.url().endsWith(workerFile)) {
        grammarRequests.push(request.url());
      }
    });
    await plainPage.goto(url, { waitUntil: 'networkidle' });
    for (const language of plainAliases) {
      const result = await plainPage.evaluate(async (mode) => {
        window.mountColdFileCode(mode);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
          busy: document.querySelector('pre').getAttribute('aria-busy'),
          text: document.querySelector('code').textContent,
        };
      }, language);
      assert.equal(result.busy, 'false', `${language}: plaintext is ready immediately`);
      assert.equal(result.text, '<literal>\n  whitespace\n');
    }
    assert.deepEqual(grammarRequests, [], 'Plaintext aliases must not fetch the grammar worker');
  } finally {
    await plainPage.close();
  }

  const blockedPage = await browser.newPage();
  let blockedRequests = 0;
  let blockedChunkError;
  try {
    await blockedPage.route(`**/${workerFile}`, (route) => {
      blockedRequests++;
      return route.abort();
    });
    await blockedPage.goto(url, { waitUntil: 'networkidle' });
    blockedChunkError = await blockedPage.evaluate(() =>
      Promise.race([
        window.warmHighlighting(100).then(
          () => 'unexpected success',
          (error) => error.message
        ),
        new Promise((resolve) => setTimeout(() => resolve('warmup still pending'), 2000)),
      ])
    );
    assert.equal(blockedChunkError, 'Timed out waiting for syntax highlighting after 100 ms');
    assert.equal(blockedRequests, 1, 'Negative warmup check must block the actual grammar worker');
  } finally {
    await blockedPage.close();
  }
  return {
    scrollOwnership,
    plainAliases,
    grammarRequests: grammarRequests.length,
    blockedRequests,
    blockedChunkError,
  };
}

try {
  const outDir = join(output, 'browser');
  await build({
    configFile: false,
    root: here,
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias: { ...workerSafeAliases, '@': join(repository, 'src') } },
    build: { outDir, chunkSizeWarningLimit: 5000, emptyOutDir: true },
  });
  await build({
    configFile: false,
    root: here,
    base: './',
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias: { ...workerSafeAliases, '@': join(repository, 'src') } },
    build: {
      outDir: join(outDir, 'loading'),
      manifest: true,
      emptyOutDir: true,
      chunkSizeWarningLimit: 5000,
      rollupOptions: { input: join(here, 'loading.html') },
    },
  });
  const grammarWorker = (await readdir(join(outDir, 'loading/assets'))).find((file) =>
    /^diff-highlight\.worker-.*\.js$/.test(file)
  );
  assert(grammarWorker, 'Cold-loading fixture must defer the actual grammar worker');
  server = createServer((req, res) => {
    const handleRequest = async () => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('..')) {
        res.writeHead(400).end();
        return;
      }
      try {
        const file = join(outDir, pathname === '/' ? 'index.html' : pathname);
        res.setHeader(
          'Content-Type',
          { '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'text/html'
        );
        res.end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    };
    void handleRequest().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.warmHighlighting());
  const source = `// comment\nconst message = "${'long source '.repeat(140)}";\n`;
  for (const [theme, keywordColor] of [
    ['dark', 'rgb(198, 120, 221)'],
    ['light', 'rgb(166, 38, 164)'],
  ]) {
    const view = await page.evaluate(
      ([content, mode]) => window.inspectHighlighting(content, 'typescript', mode),
      [source, theme]
    );
    assert.equal(view.text, source, 'Source must survive tokenization exactly');
    assert.equal(view.keywordColor, keywordColor, `${theme} keyword color`);
    assert.equal(view.commentStyle, 'italic');
    assert.equal(view.styledTokens, 0, 'Every token must be free of inline styles');
    assert.equal(view.whiteSpace, 'pre');
    assert(view.font.includes('monospace'));
    assert(view.horizontallyScrollable);
    assert.deepEqual(view.numbers, ['1', '2', '3']);
  }
  const languageColors = [
    [
      'markup',
      '<a href="link">text</a>',
      '.token.attr-name',
      'hsl(35, 99%, 36%)',
      'hsl(29, 54%, 61%)',
    ],
    [
      'markup',
      '<a href="link">text</a>',
      '.token.attr-equals',
      'hsl(230, 8%, 24%)',
      'hsl(220, 14%, 71%)',
    ],
    [
      'javascript',
      `const value = \`Hello \${name}\`;`,
      '.token.interpolation-punctuation',
      'hsl(344, 84%, 43%)',
      'hsl(5, 48%, 51%)',
    ],
    ['markdown', '**bold**', '.token.bold.content', 'hsl(35, 99%, 36%)', 'hsl(29, 54%, 61%)'],
    ['markdown', '*italic*', '.token.italic.content', 'hsl(301, 63%, 40%)', 'hsl(286, 60%, 67%)'],
    ['markdown', '~~struck~~', '.token.strike.content', 'hsl(5, 74%, 59%)', 'hsl(355, 65%, 65%)'],
    [
      'markdown',
      '[Link](https://example.com)',
      '.token.url.content',
      'hsl(221, 87%, 60%)',
      'hsl(207, 82%, 66%)',
    ],
    [
      'css',
      '@media screen { .example { color: red; } }',
      '.token.atrule.rule',
      'hsl(301, 63%, 40%)',
      'hsl(286, 60%, 67%)',
    ],
    ['json', '{ "value": null }', '.token.null.keyword', 'hsl(35, 99%, 36%)', 'hsl(29, 54%, 61%)'],
  ];
  const jsxExpression = '<Button disabled={true} count={2} onClick={() => null} />';
  for (const language of ['jsx', 'tsx']) {
    languageColors.push(
      [language, jsxExpression, '.token.tag.class-name', 'hsl(35, 99%, 36%)', 'hsl(29, 54%, 61%)'],
      [language, jsxExpression, '.token.tag.boolean', 'hsl(35, 99%, 36%)', 'hsl(29, 54%, 61%)'],
      [language, jsxExpression, '.token.tag.number', 'hsl(35, 99%, 36%)', 'hsl(29, 54%, 61%)'],
      [language, jsxExpression, '.token.tag.keyword', 'hsl(301, 63%, 40%)', 'hsl(286, 60%, 67%)']
    );
  }
  for (const language of ['javascript', 'jsx']) {
    languageColors.push([
      language,
      'class Foo extends Bar.Baz {}',
      '.token.class-name.punctuation',
      'hsl(230, 8%, 24%)',
      'hsl(220, 14%, 71%)',
    ]);
  }
  for (const [language, content, selector, light, dark] of languageColors) {
    for (const [theme, color] of [
      ['light', light],
      ['dark', dark],
    ]) {
      const result = await page.evaluate(
        async ([text, lang, mode, token, expected]) => {
          const view = await window.inspectHighlighting(text, lang, mode, token);
          const probe = document.createElement('span');
          probe.style.color = expected;
          document.body.append(probe);
          const expectedColor = getComputedStyle(probe).color;
          probe.remove();
          return {
            actual: view.selectedColor,
            expected: expectedColor,
            classes: view.selectedClasses,
            styledTokens: view.styledTokens,
          };
        },
        [content, language, theme, selector, color]
      );
      assert.equal(result.styledTokens, 0, `${theme} ${language}: all tokens use CSS`);
      assert.equal(
        result.actual,
        result.expected,
        `${theme} ${language} ${selector}: ${result.classes}`
      );
    }
  }
  const coldLoadingChecks = await verifyColdLoading(
    browser,
    `http://127.0.0.1:${server.address().port}`,
    `assets/${grammarWorker}`
  );
  const fallback = await page.evaluate(() =>
    window.inspectHighlighting('<unknown>\n  text\n', 'unregistered-language', 'light')
  );
  assert.equal(fallback.text, '<unknown>\n  text\n');
  assert.equal(fallback.keywordColor, null);
  const results = [];
  for (const lines of process.argv.includes('--verify-only') ? [] : [100, 1000]) {
    for (const optimized of [false, true]) {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(
          ([count, useCSS]) => window.runHighlightingBenchmark(count, useCSS),
          [lines, optimized]
        );
      }
      const samples = [];
      for (let i = 0; i < 9; i++) {
        const sample = await page.evaluate(
          ([count, useCSS]) => window.runHighlightingBenchmark(count, useCSS),
          [lines, optimized]
        );
        if (optimized) {
          assert.equal(sample.styledTokens, 0, 'Every measured token must use CSS');
        }
        samples.push(sample);
      }
      const medians = Object.fromEntries(
        Object.keys(samples[0]).map((key) => [
          key,
          samples.map((sample) => sample[key]).sort((a, b) => a - b)[4],
        ])
      );
      results.push({ lines, optimized, medians, samples });
    }
  }
  const screenshots = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice(14);
  let screenshotChecks;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.evaluate(() => window.showHighlightingPreview());
    // A full-page capture does not expand the viewport used by IntersectionObserver.
    // Make every matrix sample intersect before waiting for its actual colored DOM.
    const previewHeight = await page.evaluate(() =>
      Math.ceil(document.documentElement.scrollHeight)
    );
    await page.setViewportSize({ width: 1200, height: Math.max(800, previewHeight) });
    await page.waitForFunction(
      () => {
        const samples = [...document.querySelectorAll('#root pre.file-code')];
        return (
          samples.length === 16 &&
          samples.every((pre) => {
            const rect = pre.getBoundingClientRect();
            return (
              pre.getAttribute('aria-busy') === 'false' &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              [...pre.querySelectorAll('.token')].some(
                (token) => getComputedStyle(token).color !== getComputedStyle(pre).color
              )
            );
          })
        );
      },
      undefined,
      { timeout: 10_000 }
    );
    screenshotChecks = await page.evaluate(() =>
      [...document.querySelectorAll('#root pre.file-code')].map((pre) => {
        const rect = pre.getBoundingClientRect();
        return {
          theme: pre.getAttribute('data-syntax-theme'),
          language: pre.querySelector('code')?.className,
          settled: pre.getAttribute('aria-busy') === 'false',
          visible: rect.top >= 0 && rect.bottom <= innerHeight,
          colored: [...pre.querySelectorAll('.token')].some(
            (token) => getComputedStyle(token).color !== getComputedStyle(pre).color
          ),
        };
      })
    );
    assert.equal(screenshotChecks.length, 16, 'Capture all language/theme samples');
    for (const sample of screenshotChecks) {
      assert(
        sample.settled && sample.visible && sample.colored,
        `Screenshot must show settled, visible colors: ${JSON.stringify(sample)}`
      );
    }
    await page.screenshot({
      path: join(screenshots, 'file-highlighting-themes.png'),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  const bundles = process.argv.includes('--bundle') ? await measureBundles() : undefined;
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        productionBuild: true,
        viewport: { width: 1200, height: 800 },
        functionalChecks: 'passed',
        languageColorAssertions: languageColors.length * 2,
        coldLoadingChecks,
        screenshotChecks,
        results,
        bundles,
      },
      null,
      2
    )
  );
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  await rm(output, { recursive: true, force: true });
}
