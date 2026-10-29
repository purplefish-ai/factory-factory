// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  readSelectedProjectSlug,
  resolveSelectedProjectSlug,
  SELECTED_PROJECT_KEY,
} from './project-selection';
const projects = [{ slug: 'alpha' }, { slug: 'beta' }];
afterEach(() => localStorage.clear());
it('reads the stored selection and falls back to the first active project', () => {
  localStorage.setItem(SELECTED_PROJECT_KEY, 'beta');
  expect(readSelectedProjectSlug()).toBe('beta');
  expect(resolveSelectedProjectSlug(projects)).toBe('beta');
  localStorage.removeItem(SELECTED_PROJECT_KEY);
  expect(resolveSelectedProjectSlug(projects)).toBe('alpha');
  localStorage.setItem(SELECTED_PROJECT_KEY, 'archived');
  expect(resolveSelectedProjectSlug(projects)).toBe('alpha');
  expect(resolveSelectedProjectSlug([])).toBeUndefined();
});
it('tolerates blocked storage', () => {
  expect(
    readSelectedProjectSlug({
      getItem() {
        throw new Error('Storage blocked');
      },
    })
  ).toBeNull();
});
