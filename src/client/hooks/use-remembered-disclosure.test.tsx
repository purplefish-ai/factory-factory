// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useRememberedDisclosure } from './use-remembered-disclosure';

function Disclosure({ scope, section }: { scope?: string; section: string }) {
  const [open, setOpen] = useRememberedDisclosure(scope, section);
  return (
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      {section}
    </button>
  );
}

it('shares updates between mounted instances but isolates disclosure sections', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <>
          <Disclosure scope="shared" section="agents" />
          <Disclosure scope="shared" section="agents" />
          <Disclosure scope="shared" section="processes" />
        </>
      )
    );
    const buttons = host.querySelectorAll('button');
    flushSync(() => buttons[0]?.click());
    expect([...buttons].map((button) => button.getAttribute('aria-expanded'))).toEqual([
      'true',
      'true',
      'false',
    ]);
    flushSync(() => buttons[1]?.click());
    expect(buttons[0]?.getAttribute('aria-expanded')).toBe('false');
  } finally {
    flushSync(() => root.unmount());
  }
});

it('keeps unscoped instances independent without remembering them on remount', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    flushSync(() =>
      root.render(
        <>
          <Disclosure section="unscoped" />
          <Disclosure section="unscoped" />
        </>
      )
    );
  try {
    render();
    flushSync(() => host.querySelector('button')?.click());
    expect(
      [...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-expanded'))
    ).toEqual(['true', 'false']);
    flushSync(() => root.render(null));
    render();
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  } finally {
    flushSync(() => root.unmount());
  }
});
