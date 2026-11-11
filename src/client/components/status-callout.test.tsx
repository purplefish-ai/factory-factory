// @vitest-environment jsdom

import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getStatusToneStyle, STATUS_TONES } from '@/client/lib/status-tones';
import { StatusCallout } from './status-callout';

function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  const callout = container.querySelector<HTMLElement>('[data-slot="status-callout"]');
  if (!callout) {
    throw new Error('StatusCallout did not render');
  }
  return callout;
}

describe('StatusCallout', () => {
  it.each(STATUS_TONES)('renders the %s tone through the shared surface classes', (tone) => {
    const callout = render(<StatusCallout tone={tone}>Message</StatusCallout>);
    expect(callout.getAttribute('data-status-tone')).toBe(tone);
    for (const className of getStatusToneStyle(tone).surface.split(' ')) {
      expect(callout.classList.contains(className), className).toBe(true);
    }
  });

  it('shows the tone icon by default, a specific icon, an element or none', () => {
    const toneIcon = render(<StatusCallout tone="danger">Failed</StatusCallout>);
    expect(toneIcon.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(toneIcon.querySelector('svg')?.getAttribute('data-status-tone')).toBe('danger');

    const specific = render(
      <StatusCallout tone="warning" icon={ShieldWarningIcon}>
        Blocked
      </StatusCallout>
    );
    expect(specific.querySelectorAll('svg')).toHaveLength(1);

    const element = render(
      <StatusCallout tone="info" icon={<span data-testid="live" />}>
        Working
      </StatusCallout>
    );
    expect(element.querySelector('[data-testid="live"]')).not.toBeNull();
    expect(element.querySelector('svg')).toBeNull();

    const none = render(
      <StatusCallout tone="info" icon={false}>
        Plain
      </StatusCallout>
    );
    expect(none.querySelector('svg')).toBeNull();
  });

  it('puts the title above the message and the action at the trailing edge', () => {
    const callout = render(
      <StatusCallout
        tone="danger"
        role="alert"
        title={<h2>Transcript unavailable</h2>}
        action={<button type="button">Retry</button>}
      >
        Network unavailable
      </StatusCallout>
    );
    expect(callout.getAttribute('role')).toBe('alert');
    const [, content, action] = Array.from(callout.children);
    expect(content?.className).toContain('flex-1');
    expect(content?.querySelector('h2')?.parentElement?.className).toContain('font-medium');
    expect(content?.textContent).toBe('Transcript unavailableNetwork unavailable');
    // The action wraps under the message in narrow containers.
    expect(callout.className).toContain('flex-wrap');
    expect(action?.className).toContain('ml-auto');
    expect(action?.textContent).toBe('Retry');
  });

  it('keeps all text in the tone color so it stays legible on every tint', () => {
    const callout = render(
      <StatusCallout tone="warning" title="Heads up" action={<button type="button">Fix</button>}>
        Detail
      </StatusCallout>
    );
    expect(callout.outerHTML).not.toContain('text-foreground');
    expect(callout.classList.contains('text-warning')).toBe(true);
  });

  it('spans a pane as a strip with only a bottom border', () => {
    const strip = render(
      <StatusCallout tone="warning" variant="strip" size="sm">
        File truncated
      </StatusCallout>
    );
    expect(strip.className).toContain('border-x-0');
    expect(strip.className).toContain('border-t-0');
    expect(strip.className).toContain('rounded-none');
    expect(strip.className).toContain('text-xs');

    const card = render(<StatusCallout tone="warning">File truncated</StatusCallout>);
    expect(card.className).toContain('rounded-md');
    expect(card.className).toContain('text-sm');
  });

  it('lets a container restore the full border on a strip', () => {
    const strip = render(
      <StatusCallout tone="danger" variant="strip" className="rounded-md border">
        Refresh failed
      </StatusCallout>
    );
    expect(strip.className).not.toContain('border-x-0');
    expect(strip.className).toContain('rounded-md');
  });
});
