import { createElement, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { FileCode } from '../../../src/client/features/workspace/file-code';
import { usePersistentScroll } from '../../../src/client/features/workspace/use-persistent-scroll';
import { WorkspacePanelProvider } from '../../../src/client/features/workspace/workspace-panel-context';
import { ScrollArea } from '../../../src/components/ui/scroll-area';
import { waitForHighlighting } from './wait-for-highlighting.mjs';

const node = document.getElementById('root');
let mounted;

window.mountColdFileCode = (language) => {
  mounted?.unmount();
  mounted = createRoot(node);
  flushSync(() =>
    mounted.render(
      createElement(FileCode, {
        content: '<literal>\n  whitespace\n',
        language,
        theme: 'light',
      })
    )
  );
};

window.warmHighlighting = async (timeoutMs = 10_000) => {
  mounted?.unmount();
  mounted = createRoot(node);
  try {
    flushSync(() =>
      mounted.render(
        createElement(FileCode, {
          content: 'const value = 1;',
          language: 'typescript',
          theme: 'dark',
        })
      )
    );
    await waitForHighlighting(node, timeoutMs);
  } finally {
    mounted.unmount();
    mounted = undefined;
  }
};

const twoFrames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function ScrollableCode({ language }) {
  const viewportRef = useRef(null);
  const { handleScroll } = usePersistentScroll({
    tabId: 'file-benchmark',
    mode: 'code',
    viewportRef,
  });
  return createElement(
    ScrollArea,
    {
      style: { width: 360, height: 180 },
      scrollbars: 'both',
      viewportRef,
      onScroll: handleScroll,
    },
    createElement(FileCode, {
      content: `const longLine = "${'source '.repeat(200)}";`,
      language,
      theme: 'light',
    })
  );
}

function Tabs({ language, toggleRef }) {
  const [visible, setVisible] = useState(true);
  toggleRef.current = setVisible;
  return visible ? createElement(ScrollableCode, { language }) : null;
}

window.verifyScrollRestoration = async (language) => {
  mounted?.unmount();
  mounted = createRoot(node);
  const toggleRef = { current: undefined };
  try {
    flushSync(() =>
      mounted.render(
        createElement(
          WorkspacePanelProvider,
          {
            workspaceId: `highlighting-scroll-${language}`,
          },
          createElement(Tabs, { language, toggleRef })
        )
      )
    );
    await twoFrames();
    const viewport = node.querySelector('[data-slot="scroll-area-viewport"]');
    const pre = node.querySelector('pre');
    viewport.scrollLeft = 192;
    viewport.dispatchEvent(new Event('scroll'));
    await twoFrames();
    pre.scrollLeft = 96;
    const ownership = {
      outerLeft: viewport.scrollLeft,
      preLeft: pre.scrollLeft,
      preOverflow: getComputedStyle(pre).overflowX,
      outerOverflow: getComputedStyle(viewport).overflowX,
    };
    flushSync(() => toggleRef.current(false));
    flushSync(() => toggleRef.current(true));
    await twoFrames();
    return {
      ...ownership,
      restoredLeft: node.querySelector('[data-slot="scroll-area-viewport"]').scrollLeft,
    };
  } finally {
    mounted.unmount();
    mounted = undefined;
  }
};
