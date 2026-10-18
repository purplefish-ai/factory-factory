import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Prism } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import source from '../../../src/backend/services/github/service/github-cli.service.ts?raw';
import { FileCode } from '../../../src/client/features/workspace/file-code';

const node = document.getElementById('root');

function baseline(content, language, theme) {
  return createElement(
    Prism,
    {
      language,
      style: theme === 'dark' ? oneDark : oneLight,
      showLineNumbers: true,
      wrapLines: true,
      customStyle: {
        margin: 0,
        padding: '1rem',
        background: 'transparent',
        fontSize: '0.75rem',
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
      },
      codeTagProps: { style: { background: 'transparent', fontFamily: 'var(--font-mono)' } },
      lineNumberStyle: {
        minWidth: '3em',
        paddingRight: '1em',
        color: 'var(--muted-foreground)',
        background: 'transparent',
      },
      lineProps: { style: { background: 'transparent' } },
    },
    content
  );
}

window.warmHighlighting = async () => {
  const root = createRoot(node);
  try {
    flushSync(() =>
      root.render(
        createElement(FileCode, {
          content: 'const value = 1;',
          language: 'typescript',
          theme: 'dark',
        })
      )
    );
    while (!node.querySelector('.token.keyword')) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } finally {
    root.unmount();
  }
};

window.runHighlightingBenchmark = (lines, optimized) => {
  const content = source.split('\n').slice(0, lines).join('\n');
  const root = createRoot(node);
  try {
    const start = performance.now();
    flushSync(() =>
      root.render(
        optimized
          ? createElement(FileCode, { content, language: 'typescript', theme: 'dark' })
          : baseline(content, 'typescript', 'dark')
      )
    );
    const renderMs = performance.now() - start;
    node.firstElementChild.getBoundingClientRect();
    return {
      renderMs,
      renderAndLayoutMs: performance.now() - start,
      nodes: node.querySelectorAll('*').length,
      styledTokens: node.querySelectorAll('.token[style]').length,
    };
  } finally {
    root.unmount();
  }
};

window.inspectHighlighting = (content, language, theme, selector) => {
  const root = createRoot(node);
  try {
    flushSync(() => root.render(createElement(FileCode, { content, language, theme })));
    const pre = node.querySelector('pre');
    const code = node.querySelector('code');
    const keyword = node.querySelector('.token.keyword');
    const comment = node.querySelector('.token.comment');
    const clone = code.cloneNode(true);
    clone
      .querySelectorAll('.react-syntax-highlighter-line-number')
      .forEach((item) => item.remove());
    return {
      text: clone.textContent,
      numbers: [...node.querySelectorAll('.react-syntax-highlighter-line-number')].map(
        (item) => item.textContent
      ),
      keywordColor: keyword && getComputedStyle(keyword).color,
      commentStyle: comment && getComputedStyle(comment).fontStyle,
      whiteSpace: getComputedStyle(code).whiteSpace,
      font: getComputedStyle(code).fontFamily,
      horizontallyScrollable: pre.scrollWidth > node.clientWidth,
      keywordStyle: keyword?.getAttribute('style'),
      selectedClasses: selector && node.querySelector(selector)?.className,
      selectedColor:
        selector && node.querySelector(selector)
          ? getComputedStyle(node.querySelector(selector)).color
          : null,
    };
  } finally {
    root.unmount();
  }
};

window.showHighlightingPreview = () => {
  node.style.width = '1200px';
  node.style.height = 'auto';
  const root = createRoot(node);
  const examples = [
    ['typescript', '// Comment\nexport const greeting = "Hello!";\n\n\tconsole.log(greeting);\n'],
    ['javascript', `const value = \`Hello \${name}\`;\nif (value !== null) console.log(value);`],
    ['css', '.example { color: red !important; background: url("image.png"); }'],
    ['markup', '<a href="https://example.com" class="example">Link &amp; text</a>'],
    ['json', '{ "enabled": true, "count": 42, "value": null }'],
    [
      'markdown',
      '# Heading\n**Bold** and *italic*, ~~struck~~.\n> Quoted text\n[Link](https://example.com)\n- List item',
    ],
  ];
  flushSync(() =>
    root.render(
      createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '1fr 1fr' } },
        ['light', 'dark'].map((theme) =>
          createElement(
            'section',
            {
              key: theme,
              style: { minWidth: 0, background: theme === 'dark' ? '#282c34' : '#fafafa' },
            },
            examples.map(([language, content]) =>
              createElement(
                'div',
                { key: language },
                createElement(
                  'h3',
                  { style: { paddingLeft: '1rem', color: theme === 'dark' ? '#ddd' : '#333' } },
                  `${theme}: ${language}`
                ),
                createElement(FileCode, { content, language, theme })
              )
            )
          )
        )
      )
    )
  );
};
