import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationReleaseService, readInstalledApplication } from './application-release.service';

const installation = {
  packageRoot: '/installed/factory-factory',
  currentVersion: '0.5.3',
  runtimeVersions: { claude: '0.3.312', codex: '0.165.0' },
};
const latest = {
  version: '0.5.4',
  factoryFactoryRuntimeVersions: { claude: '0.3.316', codex: '0.166.0' },
};
const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function service(fetcher: typeof fetch, now = () => 0) {
  return new ApplicationReleaseService({
    fetch: fetcher,
    now,
    loadInstallation: () => installation,
  });
}

function response(data: unknown) {
  return Response.json(data);
}

describe('application release detection', () => {
  it('reports the app and newer explicitly bundled runtime packages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(latest));
    const checker = service(fetcher);
    expect(await checker.check()).toEqual({
      currentVersion: '0.5.3',
      notices: [
        {
          id: 'factory-factory',
          label: 'Factory Factory',
          currentVersion: '0.5.3',
          latestVersion: '0.5.4',
        },
        { id: 'claude', label: 'Claude', currentVersion: '0.3.312', latestVersion: '0.3.316' },
        { id: 'codex', label: 'Codex', currentVersion: '0.165.0', latestVersion: '0.166.0' },
      ],
    });
    expect(checker.getPackageRoot()).toBe('/installed/factory-factory');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/factory-factory/latest');
  });

  it.each(['0.5.3', '0.5.2', '0.4.99'])(
    'does not offer a non-newer app release %s',
    async (version) => {
      expect(
        (
          await service(
            vi.fn<typeof fetch>().mockResolvedValue(response({ ...latest, version }))
          ).check()
        ).notices
      ).toEqual([]);
    }
  );

  it('compares numeric version segments and ignores dependency ranges without explicit metadata', async () => {
    const checker = service(
      vi.fn<typeof fetch>().mockResolvedValue(
        response({
          version: '0.10.0',
          dependencies: { '@anthropic-ai/claude-agent-sdk': '^99.0.0' },
        })
      )
    );
    expect((await checker.check()).notices.map((notice) => notice.id)).toEqual(['factory-factory']);
  });

  it('only includes providers with a known installed and strictly newer available package version', async () => {
    const checker = service(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response({ ...latest, factoryFactoryRuntimeVersions: { claude: '0.3.300' } })
        )
    );
    expect((await checker.check()).notices.map((notice) => notice.id)).toEqual(['factory-factory']);
    const missingRuntime = new ApplicationReleaseService({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response(latest)),
      loadInstallation: () => ({ ...installation, runtimeVersions: {} }),
    });
    expect((await missingRuntime.check()).notices.map((notice) => notice.id)).toEqual([
      'factory-factory',
    ]);
  });

  it('coalesces simultaneous calls and caches successful metadata for one hour', async () => {
    let resolve: (value: Response) => void = () => {
      throw new Error('Fetch has not started');
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    let time = 0;
    const checker = service(fetcher, () => time);
    const first = checker.check();
    const second = checker.check();
    resolve(response(latest));
    expect(await first).toEqual(await second);
    time = 3_599_999;
    expect((await checker.check()).notices).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    time = 3_600_000;
    fetcher.mockResolvedValue(response({ version: '0.5.5' }));
    expect((await checker.check()).notices[0]?.latestVersion).toBe('0.5.5');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains previously confirmed notices offline and retries failures after five minutes', async () => {
    let time = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(latest))
      .mockRejectedValue(new Error('offline'));
    const checker = service(fetcher, () => time);
    const confirmed = await checker.check();
    time = 3_600_000;
    expect(await checker.check()).toEqual(confirmed);
    time += 299_999;
    expect(await checker.check()).toEqual(confirmed);
    expect(fetcher).toHaveBeenCalledTimes(2);
    time += 1;
    await checker.check();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    { version: '0.5.4-beta.1' },
    { version: '01.5.4' },
    { version: '99999999999999999999999999999.0.0' },
    { version: '0.5.4', factoryFactoryRuntimeVersions: { claude: '^1.0.0' } },
    { version: 42 },
    null,
  ])('ignores malformed registry data %j', async (data) => {
    expect(await service(vi.fn<typeof fetch>().mockResolvedValue(response(data))).check()).toEqual({
      currentVersion: '0.5.3',
      notices: [],
    });
  });

  it('treats unsuccessful HTTP responses and invalid JSON as unavailable', async () => {
    for (const result of [new Response('unavailable', { status: 503 }), new Response('{')]) {
      expect(
        (await service(vi.fn<typeof fetch>().mockResolvedValue(result)).check()).notices
      ).toEqual([]);
    }
  });

  it.each(['request', 'response body'])('bounds a stalled %s to five seconds', async (stage) => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      stage === 'request'
        ? new Promise<Response>(() => {
            /* Simulate a transport that ignores abort. */
          })
        : Promise.resolve(new Response(new ReadableStream()))
    );
    const request = service(fetcher).check();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await request).notices).toEqual([]);
  });
});

it('locates the running package from its module and resolves runtimes from the adapters', () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-release-'));
  temporaryDirectories.push(root);
  const writePackage = (relative: string, data: unknown) => {
    const directory = join(root, relative);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(data));
  };
  writePackage('', { name: 'factory-factory', version: '0.7.3' });
  writePackage('node_modules/@anthropic-ai/claude-agent-sdk', {
    name: '@anthropic-ai/claude-agent-sdk',
    version: '99.0.0',
  });
  writePackage('node_modules/@agentclientprotocol/claude-agent-acp', {
    name: '@agentclientprotocol/claude-agent-acp',
    version: '1.0.0',
  });
  writePackage(
    'node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk',
    { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.312', exports: { '.': './sdk.mjs' } }
  );
  writeFileSync(
    join(
      root,
      'node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
    ),
    'export {};'
  );
  writePackage('node_modules/@agentclientprotocol/codex-acp', {
    name: '@agentclientprotocol/codex-acp',
    version: '1.0.0',
  });
  writePackage('node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex', {
    name: '@openai/codex',
    version: '0.165.0',
  });
  expect(
    readInstalledApplication(pathToFileURL(join(root, 'dist/src/backend/service.js')).href)
  ).toEqual({
    packageRoot: root,
    currentVersion: '0.7.3',
    runtimeVersions: { claude: '0.3.312', codex: '0.165.0' },
  });
});
