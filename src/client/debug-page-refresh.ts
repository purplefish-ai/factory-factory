/**
 * DEBUG HELPER — import this at the top of main.tsx to detect what triggers
 * full-page navigations / refreshes.
 *
 * The browser's Location object is read-only, so instead of monkey-patching it
 * directly we rely on event listeners (click capture, beforeunload) and patch
 * the APIs that *are* writable (History, HTMLFormElement, window.open).
 *
 * Remove this file (and its import) once you've found the culprit.
 */

/* biome-ignore-all lint/suspicious/noConsole: debug helper file */

const TAG = '[debug-page-refresh]';

// ---------------------------------------------------------------------------
// 1.  Intercept <a> clicks that would trigger a full navigation
// ---------------------------------------------------------------------------

document.addEventListener(
  'click',
  (e) => {
    const anchor = (e.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) {
      return;
    }

    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }

    if (anchor.target === '_blank') {
      return;
    }

    if (href.startsWith('#')) {
      return;
    }

    try {
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) {
        return;
      }
    } catch {
      return;
    }

    queueMicrotask(() => {
      if (!e.defaultPrevented) {
        console.warn(
          `${TAG} <a> click will cause full navigation to "${href}" (defaultPrevented=false)`,
          anchor,
          new Error('stack')
        );
        // biome-ignore lint: debug helper
        debugger;
      }
    });
  },
  true
);

// ---------------------------------------------------------------------------
// 2.  beforeunload — last-resort catch-all
// ---------------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
  console.warn(`${TAG} beforeunload fired — page is about to unload`);
  console.trace(`${TAG} beforeunload trace`);
  // biome-ignore lint: debug helper
  debugger;
});

// ---------------------------------------------------------------------------
// 3.  window.open — catch "_self" / "_top" / "_parent"
// ---------------------------------------------------------------------------

const origOpen = window.open.bind(window);
window.open = function debugOpen(url?: string | URL, target?: string, features?: string) {
  if (target === '_self' || target === '_parent' || target === '_top') {
    console.warn(`${TAG} window.open("${url}", "${target}")`, new Error('stack'));
    // biome-ignore lint: debug helper
    debugger;
  }
  return origOpen(url, target, features);
};

// ---------------------------------------------------------------------------
// 4.  HTMLFormElement.submit
// ---------------------------------------------------------------------------

const origFormSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function debugSubmit(this: HTMLFormElement) {
  console.warn(`${TAG} <form>.submit()`, this, new Error('stack'));
  // biome-ignore lint: debug helper
  debugger;
  return origFormSubmit.call(this);
};

// ---------------------------------------------------------------------------
// 5.  History API — logged at debug level for context
// ---------------------------------------------------------------------------

const origPushState = history.pushState.bind(history);
const origReplaceState = history.replaceState.bind(history);

history.pushState = function debugPushState(...args: Parameters<typeof history.pushState>) {
  console.debug(`${TAG} history.pushState`, args[2]);
  return origPushState(...args);
};

history.replaceState = function debugReplaceState(
  ...args: Parameters<typeof history.replaceState>
) {
  console.debug(`${TAG} history.replaceState`, args[2]);
  return origReplaceState(...args);
};

// ---------------------------------------------------------------------------

console.info(
  `${TAG} Page-refresh debugging is active. ` +
    'Any navigation / reload will pause in the debugger and log a stack trace.'
);

export {};
