// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationUpdates, ApplicationUpdateStatus } from '@/shared/application-updates';
import {
  ApplicationUpdateBanner,
  ApplicationUpdateBannerContent,
  claimUpdateReload,
} from './application-update-banner';

const mocks = vi.hoisted(() => ({
  data: undefined as ApplicationUpdates | undefined,
  requestOptions: undefined as
    | {
        onSuccess: (status: ApplicationUpdateStatus) => void;
        onError: (error: { message: string }) => void;
      }
    | undefined,
  request: vi.fn(),
  cancel: vi.fn(),
  refetch: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      checkUpdates: { useQuery: () => ({ data: mocks.data, refetch: mocks.refetch }) },
      requestUpdate: {
        useMutation: (options: NonNullable<typeof mocks.requestOptions>) => {
          mocks.requestOptions = options;
          return { mutate: mocks.request, isPending: false };
        },
      },
      cancelUpdate: { useMutation: () => ({ mutate: mocks.cancel, isPending: false }) },
    },
  },
}));

const updates: ApplicationUpdates = {
  currentVersion: '0.5.3',
  automaticUpdate: true,
  manualCommand: 'npm install -g factory-factory@0.5.4',
  status: { phase: 'idle' },
  notices: [
    {
      id: 'factory-factory',
      label: 'Factory Factory',
      currentVersion: '0.5.3',
      latestVersion: '0.5.4',
    },
    { id: 'claude', label: 'Claude', currentVersion: '0.3.315', latestVersion: '0.3.316' },
    { id: 'codex', label: 'Codex', currentVersion: '2.4.0', latestVersion: '2.5.0' },
  ],
};
const callbacks = { onUpdate: vi.fn(), onCancel: vi.fn(), onDismiss: vi.fn() };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.data = updates;
});
afterEach(() => vi.unstubAllGlobals());

describe('application update notices', () => {
  it('shows independent versions with one shared update action and restart disclosure', () => {
    const html = renderToStaticMarkup(
      <ApplicationUpdateBannerContent {...callbacks} updates={updates} />
    );
    expect(html).toContain('Factory Factory');
    expect(html).toContain('0.5.3');
    expect(html).toContain('0.5.4');
    expect(html).toContain('Claude');
    expect(html).toContain('Codex');
    expect(html).toContain('Updates with Factory Factory');
    expect(html.match(/>Update<\/button>/g)).toHaveLength(1);
    expect(html).toContain('terminals and run scripts');
    expect(html).toContain('Dismiss Claude update');
  });

  it('explains manual installation without an automatic action', () => {
    const html = renderToStaticMarkup(
      <ApplicationUpdateBannerContent
        {...callbacks}
        updates={{ ...updates, automaticUpdate: false }}
      />
    );
    expect(html).toContain('npm install -g factory-factory@0.5.4');
    expect(html).not.toContain('>Update</button>');
    expect(html).toContain('Restart Factory Factory');
  });

  it.each(['waiting', 'preparing', 'restarting'] as const)(
    'shares %s progress across providers',
    (phase) => {
      const html = renderToStaticMarkup(
        <ApplicationUpdateBannerContent
          {...callbacks}
          updates={{ ...updates, status: { phase, targetVersion: '0.5.4' } }}
        />
      );
      expect(html).toContain('Claude');
      expect(html).toContain('Updates with Factory Factory');
      expect(html.includes('>Cancel update</button>')).toBe(phase === 'waiting');
      expect(html).not.toContain('>Update</button>');
    }
  );

  it('offers retry and dismissal after installation fails', () => {
    const html = renderToStaticMarkup(
      <ApplicationUpdateBannerContent
        {...callbacks}
        updates={{
          ...updates,
          status: {
            phase: 'failed',
            error: 'Installation could not finish.',
            targetVersion: '0.5.4',
          },
        }}
      />
    );
    expect(html).toContain('Installation could not finish.');
    expect(html).toContain('>Retry update</button>');
    expect(html).toContain('Dismiss Factory Factory update');
  });

  it('keeps durable recovery errors visible without release notices and supports retry and explicit dismissal', () => {
    mocks.data = {
      ...updates,
      notices: [],
      status: {
        phase: 'failed',
        targetVersion: '0.5.4',
        error: 'The replacement could not start.',
      },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'The replacement could not start.'
      );
      mocks.data = undefined;
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'The replacement could not start.'
      );
      flushSync(() =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Retry update')
          ?.click()
      );
      expect(mocks.request).toHaveBeenCalledWith({ version: '0.5.4' });
      flushSync(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Dismiss update error"]')?.click()
      );
      expect(container.querySelector('[aria-label="Application updates"]')).toBeNull();
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('preserves a recovery error when every release notice is dismissed', () => {
    mocks.data = {
      ...updates,
      status: {
        phase: 'failed',
        targetVersion: '0.5.4',
        error: 'Update recovery needs attention.',
      },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      for (const label of ['Factory Factory', 'Claude', 'Codex']) {
        flushSync(() =>
          container
            .querySelector<HTMLButtonElement>(`[aria-label="Dismiss ${label} update"]`)
            ?.click()
        );
      }
      expect(container.querySelectorAll('li')).toHaveLength(0);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Update recovery needs attention.'
      );
      flushSync(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Dismiss update error"]')?.click()
      );
      expect(container.textContent).toBe('');
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('persists dismissal per notice and release without hiding other providers or later releases', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      const dismiss = container.querySelector<HTMLButtonElement>(
        '[aria-label="Dismiss Claude update"]'
      );
      expect(dismiss).not.toBeNull();
      flushSync(() => dismiss?.click());
      expect(container.textContent).not.toContain('0.3.316');
      expect(container.textContent).toContain('Codex');
      flushSync(() => root.render(null));
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(container.textContent).not.toContain('0.3.316');
      mocks.data = {
        ...updates,
        notices: updates.notices.map((notice) =>
          notice.id === 'claude' ? { ...notice, latestVersion: '0.3.317' } : notice
        ),
      };
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(container.textContent).toContain('0.3.317');
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('requests the advertised app release and allows cancellation only while waiting', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      flushSync(() =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Update')
          ?.click()
      );
      expect(mocks.request).toHaveBeenCalledWith({ version: '0.5.4' });
      mocks.data = { ...updates, status: { phase: 'waiting', targetVersion: '0.5.4' } };
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      flushSync(() =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Cancel update')
          ?.click()
      );
      expect(mocks.cancel).toHaveBeenCalled();
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('shows accepted waiting progress before the next poll', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      flushSync(() =>
        mocks.requestOptions?.onSuccess({ phase: 'waiting', targetVersion: '0.5.4' })
      );
      expect(container.textContent).toContain('Waiting for active agent work');
      expect(container.textContent).toContain('Cancel update');
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('shows a new failure after retrying a dismissed error', () => {
    mocks.data = {
      ...updates,
      status: { phase: 'failed', targetVersion: '0.5.4', error: 'First failure' },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      flushSync(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Dismiss update error"]')?.click()
      );
      expect(container.textContent).not.toContain('First failure');
      flushSync(() =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Update')
          ?.click()
      );
      flushSync(() => mocks.requestOptions?.onError({ message: 'New installation failure' }));
      expect(container.textContent).toContain('New installation failure');
      expect(container.textContent).toContain('Retry update');
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('keeps restart progress visible while the server is unavailable', () => {
    mocks.data = { ...updates, status: { phase: 'restarting', targetVersion: '0.5.4' } };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      mocks.data = undefined;
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(container.textContent).toContain('Restarting Factory Factory');
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('reloads the frontend once when the restarted server reports its target version', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { localStorage, sessionStorage, location: { reload } });
    mocks.data = { ...updates, status: { phase: 'restarting', targetVersion: '0.5.8' } };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(reload).not.toHaveBeenCalled();
      mocks.data = { ...updates, currentVersion: '0.5.8', notices: [], status: { phase: 'idle' } };
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(reload).toHaveBeenCalledOnce();
      mocks.data = { ...mocks.data };
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('renders safely when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ApplicationUpdateBanner />));
      flushSync(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Dismiss Claude update"]')?.click()
      );
      expect(container.textContent).not.toContain('0.3.316');
      expect(container.textContent).toContain('Factory Factory');
    } finally {
      flushSync(() => root.unmount());
      vi.restoreAllMocks();
    }
  });
});

describe('update reconnect reload protection', () => {
  it('avoids a reload loop when its durable guard cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(claimUpdateReload('0.5.6', '0.5.6')).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reloads only once after the running version reaches the requested target', () => {
    expect(claimUpdateReload('0.5.3', '0.5.4')).toBe(false);
    expect(claimUpdateReload('0.5.4', '0.5.4')).toBe(true);
    expect(claimUpdateReload('0.5.4', '0.5.4')).toBe(false);
    expect(claimUpdateReload('0.5.5', '0.5.5')).toBe(true);
  });
});
