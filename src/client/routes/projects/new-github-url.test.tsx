// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewProjectPage from './new';

const mocks = vi.hoisted(() => ({
  createFromGithub: vi.fn(),
  auth: {
    data: { authenticated: true } as { authenticated: boolean } | undefined,
    isLoading: false,
    error: null as { message: string } | null,
    refetch: vi.fn(async () => undefined),
  },
}));
vi.mock('@/client/components/app-header-context', () => ({
  useAppHeader: () => undefined,
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/logo', () => ({ Logo: () => null }));
vi.mock('@/client/components/project-selector', () => ({ ProjectSelectorDropdown: () => null }));
vi.mock('@/client/features/data-import/data-import-button', () => ({
  DataImportButton: () => null,
}));
vi.mock('@/client/features/project/onboarding-cli-health', () => ({
  OnboardingCliHealth: () => null,
}));
vi.mock('@/client/features/project/setup-terminal-modal', () => ({
  SetupTerminalModal: () => null,
}));
vi.mock('@/client/features/project/startup-script-form', () => ({ StartupScriptForm: () => null }));
vi.mock('@/client/hooks/use-project-header-navigation', () => ({
  useProjectHeaderNavigation: () => ({ projects: [], selectedProjectSlug: '' }),
}));
vi.mock('@/client/hooks/use-cli-health-refresh', () => ({
  useCLIHealthRefresh: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ project: { list: { invalidate: vi.fn() } } }),
    project: {
      checkFactoryConfig: { useQuery: () => ({ data: { exists: false } }) },
      checkGithubAuth: {
        useQuery: () => mocks.auth,
      },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      createFromGithub: {
        useMutation: () => ({ mutate: mocks.createFromGithub, isPending: false }),
      },
    },
  },
}));

let root: Root;
let container: HTMLDivElement;
let actDescriptor: PropertyDescriptor | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.auth.data = { authenticated: true };
  mocks.auth.error = null;
  actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
    writable: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (actDescriptor) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

async function enterUrl(url: string) {
  const input = container.querySelector<HTMLInputElement>('#onboard-gh-githubUrl');
  expect(input).not.toBeNull();
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, url);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitButton() {
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(button).not.toBeNull();
  return button!;
}

async function submitForm() {
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
}

const invalidSegments = [
  '..',
  '.',
  '.name',
  'name.',
  '-name',
  'name-',
  'name space',
  'name%2Fother',
];
const invalidUrls = invalidSegments.flatMap((segment) => [
  `https://github.com/${segment}/repo`,
  `https://github.com/owner/${segment}`,
  `git@github.com:${segment}/repo.git`,
  `git@github.com:owner/${segment}`,
]);

const validUrls = ['http://github.com/', 'https://github.com/', 'git@github.com:'].flatMap(
  (prefix) => ['', '.git', '/', '.git/'].map((suffix) => `${prefix}OwNeR-1/RePo_2.name${suffix}`)
);

describe('GitHub authentication check', () => {
  it('shows a failed check with Retry instead of hiding the auth status', async () => {
    mocks.auth.data = undefined;
    mocks.auth.error = { message: 'gh is not responding' };
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NewProjectPage />
        </MemoryRouter>
      )
    );
    const alert = [...container.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent?.includes("Couldn't check GitHub authentication")
    );
    expect(alert?.textContent).toContain('gh is not responding');
    await act(async () => alert?.querySelector('button')?.click());
    expect(mocks.auth.refetch).toHaveBeenCalledOnce();
  });

  it('keeps the cached status and adds a notice when a recheck fails', async () => {
    mocks.auth.error = { message: 'gh is not responding' };
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NewProjectPage />
        </MemoryRouter>
      )
    );
    expect(container.textContent).toContain('Authenticated');
    const notice = [...container.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent?.includes("Couldn't refresh GitHub authentication")
    );
    expect(notice?.textContent).toContain('gh is not responding');
  });
});

describe('New Project GitHub URL validation', () => {
  it.each(invalidUrls)('shows inline validation and blocks submission for %s', async (url) => {
    await enterUrl(url);
    expect(container.textContent).toContain('Invalid GitHub URL');
    expect(container.textContent).not.toContain('Will clone');
    expect(submitButton().disabled).toBe(true);
    // Also guard programmatic submission, which bypasses the disabled button.
    await submitForm();
    expect(mocks.createFromGithub).not.toHaveBeenCalled();
  });

  it.each(validUrls)('previews and submits the supported URL %s', async (url) => {
    await enterUrl(`  ${url}  `);
    expect(container.textContent).toContain('Will clone OwNeR-1/RePo_2.name');
    expect(container.textContent).not.toContain('Invalid GitHub URL');
    expect(submitButton().disabled).toBe(false);
    await submitForm();
    expect(mocks.createFromGithub).toHaveBeenCalledExactlyOnceWith({
      githubUrl: url,
      startupScriptCommand: undefined,
      startupScriptPath: undefined,
    });
  });
});
