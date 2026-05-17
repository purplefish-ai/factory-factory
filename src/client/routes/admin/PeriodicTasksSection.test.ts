import { describe, expect, it, vi } from 'vitest';
import {
  formatRelativeTime,
  getInitialProjectSlug,
  persistSelectedProjectSlug,
  SELECTED_PROJECT_KEY,
} from './PeriodicTasksSection';

const projects = [
  { id: 'project-1', slug: 'alpha', name: 'Alpha' },
  { id: 'project-2', slug: 'beta', name: 'Beta' },
];

describe('PeriodicTasksSection helpers', () => {
  it('labels only near-current timestamps as now', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect(formatRelativeTime(new Date(now - 4000), now)).toBe('now');
    expect(formatRelativeTime(new Date(now - 60_000), now)).toBe('1m overdue');
    expect(formatRelativeTime(new Date(now + 60_000), now)).toBe('in 1m');
  });

  it('reads the initial project slug from storage before falling back to the first project', () => {
    expect(
      getInitialProjectSlug(projects, {
        getItem: () => 'beta',
      })
    ).toBe('beta');

    expect(
      getInitialProjectSlug(projects, {
        getItem: () => null,
      })
    ).toBe('alpha');
  });

  it('persists project selection changes to storage', () => {
    const storage = { setItem: vi.fn() };

    persistSelectedProjectSlug('beta', storage);

    expect(storage.setItem).toHaveBeenCalledWith(SELECTED_PROJECT_KEY, 'beta');
  });
});
