import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { createAppQueryClient } from '@/client/lib/query-client';
import { trpc } from '@/client/lib/trpc';
import { settle } from '@/test-utils/react-act';

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

/**
 * jsdom lacks the layout APIs Radix Select and Slider call. `vi.unstubAllGlobals`
 * undoes the globals; the `scrollIntoView` no-op stays for the rest of the file.
 */
export function stubRadixLayout() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  Element.prototype.scrollIntoView ??= vi.fn();
}

/** Opens the Radix select `#triggerId` and picks the option labelled `label`. */
export async function chooseOption(container: HTMLElement, triggerId: string, label: string) {
  await act(async () => container.querySelector<HTMLElement>(`#${triggerId}`)?.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (element) => element.textContent === label
  );
  if (!option) {
    throw new Error(`No option "${label}" for #${triggerId}`);
  }
  await act(async () => option.click());
}

/** Server-side user settings for frontend tests; extend per test with `settings`. */
export const TEST_USER_SETTINGS = {
  preferredIde: 'cursor',
  customIdeCommand: null as string | null,
  playSoundOnComplete: true,
  childWorkspacesEnabled: true,
  ticketDispatchPrompt: null as string | null,
  ratchetEnabled: false,
  ratchetReplyToPrComments: true,
  ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
  defaultSessionProvider: 'CLAUDE',
  defaultClaudeModel: 'sonnet',
  defaultCodexModel: 'default',
  defaultClaudeReasoningEffort: null as string | null,
  defaultCodexReasoningEffort: null as string | null,
  defaultWorkspacePermissions: 'STRICT',
  automationPermissions: 'RELAXED',
  reviewerSessionProvider: 'CODEX',
  reviewerClaudeModel: null as string | null,
  reviewerCodexModel: null as string | null,
  postReviewToGitHub: true,
  appearanceColorScheme: 'factory',
  appearanceBackgroundColor: null as string | null,
  appearanceForegroundColor: null as string | null,
  appearanceFontScale: 100,
  appearanceFontSans: null as string | null,
  appearanceFontMono: null as string | null,
};

export type TestUserSettings = typeof TEST_USER_SETTINGS;

/** A request the test answers itself, because its path is listed in `held`. */
export interface HeldRequest {
  path: string;
  input: unknown;
  /** Answers as the unheld server would, applying an update. */
  respond: () => void;
  resolve: (data: unknown) => void;
  reject: (message?: string) => void;
}

export interface SettingsServerOptions {
  settings?: Partial<TestUserSettings>;
  /** Answers for other procedures, keyed by path. Throw to fail the request. */
  handlers?: Record<string, (input: unknown) => unknown>;
  /** Paths whose requests wait in `held` until the test answers them. */
  hold?: string[];
}

/**
 * A fake backend for user settings: `userSettings.get` returns `settings`,
 * and `userSettings.update` merges its input into them and returns the result.
 */
export function createSettingsServer({
  settings: initial = {},
  handlers = {},
  hold = [],
}: SettingsServerOptions = {}) {
  const server = {
    settings: { ...TEST_USER_SETTINGS, ...initial },
    requests: [] as Array<{ path: string; input: unknown }>,
    held: [] as HeldRequest[],
    /** Fail every `userSettings.update` with this message while set. */
    failUpdates: null as string | null,
  };
  const answer = (path: string, input: unknown): unknown => {
    if (path === 'userSettings.get') {
      return { ...server.settings };
    }
    if (path === 'userSettings.update') {
      if (server.failUpdates !== null) {
        throw new Error(server.failUpdates);
      }
      server.settings = { ...server.settings, ...(typeof input === 'object' ? input : {}) };
      return { ...server.settings };
    }
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`No test handler for ${path}`);
    }
    return handler(input);
  };
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            server.requests.push({ path: op.path, input: op.input });
            const resolve = (data: unknown) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            const reject = (message = 'Request rejected') =>
              observer.error(new TRPCClientError(message));
            const respond = () => {
              try {
                resolve(answer(op.path, op.input));
              } catch (error) {
                reject(error instanceof Error ? error.message : String(error));
              }
            };
            if (hold.includes(op.path)) {
              server.held.push({ path: op.path, input: op.input, respond, resolve, reject });
              return;
            }
            respond();
          }),
    ],
  });
  return Object.assign(server, { client });
}

export type SettingsServer = ReturnType<typeof createSettingsServer>;

export interface RenderedSettings {
  container: HTMLDivElement;
  queryClient: QueryClient;
  unmount: () => Promise<void>;
}

/** Renders `element` against `server` with the app's QueryClient (no retries). */
export async function renderWithSettingsServer(
  element: ReactElement,
  { client }: SettingsServer
): Promise<RenderedSettings> {
  const queryClient = createAppQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(() => {
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
      </trpc.Provider>
    );
  });
  await settle();
  return {
    container,
    queryClient,
    unmount: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}
