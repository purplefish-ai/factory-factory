// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryStateQuery } from '@/client/components/query-state';
import { SettingRow, SettingsSection } from './settings-section';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderSection(query: QueryStateQuery<{ enabled: boolean }>) {
  const children = vi.fn((data: { enabled: boolean }) => (
    <SettingRow label="Enabled" htmlFor="enabled" description="Turns it on." saving>
      <input id="enabled" type="checkbox" readOnly checked={data.enabled} />
    </SettingRow>
  ));
  act(() =>
    root.render(
      <SettingsSection
        title="Example"
        description="An example section"
        query={query}
        errorTitle="Couldn't load example settings"
      >
        {children}
      </SettingsSection>
    )
  );
  return children;
}

describe('SettingsSection', () => {
  it('keeps the header and holds back controls while loading', () => {
    const children = renderSection({
      data: undefined,
      error: null,
      isFetching: true,
      refetch: vi.fn(),
    });
    expect(container.textContent).toContain('Example');
    expect(container.textContent).toContain('An example section');
    expect(children).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBeNull();
  });

  it('shows the error with Retry instead of controls when the query fails', () => {
    const refetch = vi.fn();
    const children = renderSection({
      data: undefined,
      error: { message: 'Database is locked' },
      isFetching: false,
      refetch,
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load example settings");
    expect(alert?.textContent).toContain('Database is locked');
    expect(children).not.toHaveBeenCalled();
    act(() => container.querySelector('button')?.click());
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('renders the controls with loaded data and marks a saving row', () => {
    renderSection({ data: { enabled: true }, error: null, isFetching: false, refetch: vi.fn() });
    expect(container.querySelector<HTMLInputElement>('#enabled')?.checked).toBe(true);
    expect(container.querySelector('label[for="enabled"]')?.textContent).toBe('Enabled');
    expect(container.querySelector('[aria-label="Saving"]')).not.toBeNull();
    expect(container.textContent).toContain('Turns it on.');
  });
});
