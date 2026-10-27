export const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

export function readSelectedProjectSlug(
  storage: Pick<Storage, 'getItem'> = localStorage
): string | null {
  try {
    return storage.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function writeSelectedProjectSlug(
  slug: string,
  storage: Pick<Storage, 'setItem'> = localStorage
): void {
  try {
    storage.setItem(SELECTED_PROJECT_KEY, slug);
  } catch {
    // Non-blocking: selection still updates even if localStorage is unavailable.
  }
}

export function resolveSelectedProjectSlug(
  projects: Array<{ slug: string }> | undefined
): string | undefined {
  if (!projects || projects.length === 0) {
    return undefined;
  }

  const storedSlug = readSelectedProjectSlug();
  if (storedSlug && projects.some((project) => project.slug === storedSlug)) {
    return storedSlug;
  }

  return projects[0]?.slug;
}
