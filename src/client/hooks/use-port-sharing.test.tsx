import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunScriptLaunch } from '@/client/features/workspace/use-run-script-launch';
import { usePortSharing } from './use-port-sharing';

const statusQuery = vi.hoisted(() => vi.fn());
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    portShare: { getStatus: { useQuery: statusQuery } },
    workspace: {
      getRunScriptStatus: {
        useQuery: () => ({ data: { status: 'RUNNING', port: 3000, proxyUrl: null } }),
      },
    },
  },
}));

function Status() {
  return <output>{String(usePortSharing())}</output>;
}

function RunLink() {
  const launch = useRunScriptLaunch('workspace-1');
  return launch ? <a href={launch.href}>Run</a> : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('remote port sharing status', () => {
  it.each([
    { data: undefined, isError: false },
    { data: undefined, isError: true },
    { data: { available: false }, isError: true },
    { data: { available: true }, isError: true },
  ])('withholds Run links when status is unknown: %j', (query) => {
    vi.stubGlobal('window', { location: { hostname: 'factory.example' } });
    statusQuery.mockReturnValue(query);

    expect(renderToStaticMarkup(<Status />)).toBe('<output>undefined</output>');
    expect(renderToStaticMarkup(<RunLink />)).toBe('');
  });

  it.each([
    { available: true, href: '/proxy/3000/' },
    { available: false, href: 'http://localhost:3000' },
  ])('uses confirmed availability: $available', ({ available, href }) => {
    vi.stubGlobal('window', { location: { hostname: 'factory.example' } });
    statusQuery.mockReturnValue({ data: { available }, isError: false });

    expect(renderToStaticMarkup(<RunLink />)).toBe(`<a href="${href}">Run</a>`);
  });
});

it.each(['localhost', '127.0.0.1', '[::1]'])(
  'keeps local links on %s after a query error',
  (hostname) => {
    vi.stubGlobal('window', { location: { hostname } });
    statusQuery.mockReturnValue({ data: undefined, isError: true });

    expect(renderToStaticMarkup(<Status />)).toBe('<output>false</output>');
    expect(renderToStaticMarkup(<RunLink />)).toBe('<a href="http://localhost:3000">Run</a>');
  }
);

it('keeps server rendering independent of the disabled status query', () => {
  statusQuery.mockReturnValue({ data: undefined, isError: true });
  expect(renderToStaticMarkup(<Status />)).toBe('<output>false</output>');
});
