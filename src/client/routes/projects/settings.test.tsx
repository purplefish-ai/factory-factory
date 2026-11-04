// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { expect, it } from 'vitest';
import ProjectSettingsRedirect from './settings';

function Destination() {
  const { pathname, search } = useLocation();
  return (
    <output>
      {pathname}
      {search}
    </output>
  );
}

it('redirects legacy project settings bookmarks to the inline project accordion', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={['/projects/beta/settings']}>
          <Routes>
            <Route path="/projects/:slug/settings" element={<ProjectSettingsRedirect />} />
            <Route path="/admin/project" element={<Destination />} />
          </Routes>
        </MemoryRouter>
      )
    );
    expect(container.textContent).toBe('/admin/project?project=beta');
    expect(container.querySelector('nav')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
