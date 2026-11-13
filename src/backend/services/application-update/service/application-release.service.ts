import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toError } from '@/backend/lib/error-utils';
import { configService, type ReleaseCheckConfig } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { releaseVersionSchema, type UpdateNotice } from '@/shared/application-updates';

const logger = createLogger('application-release');

const stableVersionSchema = releaseVersionSchema.refine((version) =>
  version.split('.').every((part) => Number.isSafeInteger(Number(part)))
);
const packageSchema = z.object({ name: z.string(), version: z.string() });
const runtimeVersionsSchema = z.object({
  claude: stableVersionSchema.optional(),
  codex: stableVersionSchema.optional(),
});
const releaseSchema = z.object({
  version: stableVersionSchema,
  factoryFactoryRuntimeVersions: runtimeVersionsSchema.optional(),
});
type RuntimeVersions = z.infer<typeof runtimeVersionsSchema>;
type Release = z.infer<typeof releaseSchema>;
interface InstalledApplication {
  packageRoot: string;
  currentVersion: string;
  runtimeVersions: RuntimeVersions;
}
interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  loadInstallation?: () => InstalledApplication;
  onError?: (error: unknown) => void;
  releaseCheck?: () => ReleaseCheckConfig;
}
interface ReleaseCheck {
  currentVersion: string;
  notices: UpdateNotice[];
}

function resolveRuntimeManifest(
  fromAdapter: ReturnType<typeof createRequire>,
  runtime: string
): string {
  try {
    return fromAdapter.resolve(`${runtime}/package.json`);
  } catch {
    let directory = dirname(fromAdapter.resolve(runtime));
    while (true) {
      const path = join(directory, 'package.json');
      try {
        const manifest = packageSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (manifest.success && manifest.data.name === runtime) {
          return path;
        }
      } catch {
        /* The entrypoint may live below its package manifest. */
      }
      const parent = dirname(directory);
      if (parent === directory) {
        throw new Error(`Unable to locate ${runtime} package metadata`);
      }
      directory = parent;
    }
  }
}

/** Resolve from the adapter itself: its SDK can differ from the app's direct dependency. */
function readRuntimeVersion(packageRoot: string, adapter: string, runtime: string) {
  try {
    const fromApp = createRequire(join(packageRoot, 'package.json'));
    const fromAdapter = createRequire(fromApp.resolve(`${adapter}/package.json`));
    const manifest = packageSchema.parse(
      JSON.parse(readFileSync(resolveRuntimeManifest(fromAdapter, runtime), 'utf8'))
    );
    return stableVersionSchema.parse(manifest.version);
  } catch {
    return undefined;
  }
}

export function readInstalledApplication(moduleUrl = import.meta.url): InstalledApplication {
  const modulePath = fileURLToPath(moduleUrl).replace(/\.asar\.unpacked([/\\])/, '.asar$1');
  let directory = dirname(modulePath);
  while (true) {
    try {
      const manifest = packageSchema.parse(
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      );
      if (manifest.name === 'factory-factory') {
        return {
          packageRoot: directory,
          currentVersion: manifest.version,
          runtimeVersions: {
            claude: readRuntimeVersion(
              directory,
              '@agentclientprotocol/claude-agent-acp',
              '@anthropic-ai/claude-agent-sdk'
            ),
            codex: readRuntimeVersion(directory, '@agentclientprotocol/codex-acp', '@openai/codex'),
          },
        };
      }
    } catch {
      // Compiled code and packaged desktop builds may add intermediate directories.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Unable to locate the running Factory Factory package');
    }
    directory = parent;
  }
}

function isNewer(available: string, installed: string) {
  if (!stableVersionSchema.safeParse(installed).success) {
    return false;
  }
  const current = installed.split('.').map(Number);
  const next = available.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (next[index] ?? 0) - (current[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

export class ApplicationReleaseService {
  private readonly installed: InstalledApplication;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly releaseCheck: () => ReleaseCheckConfig;
  private latest: Release | undefined;
  private latestRegistryUrl: string | undefined;
  private expiresAt = 0;
  private pending: Promise<void> | undefined;

  constructor(dependencies: Dependencies = {}) {
    this.installed = (dependencies.loadInstallation ?? readInstalledApplication)();
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.onError =
      dependencies.onError ??
      ((error) => logger.debug('Release check unavailable', { error: toError(error).message }));
    this.releaseCheck = dependencies.releaseCheck ?? (() => configService.getReleaseCheckConfig());
  }

  getPackageRoot(): string {
    return this.installed.packageRoot;
  }

  async check(): Promise<ReleaseCheck> {
    const { enabled, registryUrl } = this.releaseCheck();
    if (!enabled) {
      return { currentVersion: this.installed.currentVersion, notices: [] };
    }
    if (this.pending === undefined && registryUrl !== this.latestRegistryUrl) {
      // A release cached from another registry says nothing about this one.
      this.latest = undefined;
      this.expiresAt = 0;
      this.latestRegistryUrl = registryUrl;
    }
    if (this.pending !== undefined) {
      await this.pending;
    } else if (this.now() >= this.expiresAt) {
      this.pending = this.refresh(registryUrl).finally(() => {
        this.pending = undefined;
      });
      await this.pending;
    }
    const { currentVersion, runtimeVersions } = this.installed;
    const notices: UpdateNotice[] = [];
    if (this.latest && isNewer(this.latest.version, currentVersion)) {
      notices.push({
        id: 'factory-factory',
        label: 'Factory Factory',
        currentVersion,
        latestVersion: this.latest.version,
      });
      for (const [id, label] of [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
      ] as const) {
        const current = runtimeVersions[id];
        const available = this.latest.factoryFactoryRuntimeVersions?.[id];
        if (current && available && isNewer(available, current)) {
          notices.push({ id, label, currentVersion: current, latestVersion: available });
        }
      }
    }
    return { currentVersion, notices };
  }

  private async refresh(registryUrl: string): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Release check timed out'));
      }, 5000);
    });
    try {
      const request = async () => {
        const response = await this.fetch(`${registryUrl}/factory-factory/latest`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          redirect: 'error',
        });
        if (!response.ok) {
          throw new Error('Release registry unavailable');
        }
        return releaseSchema.parse(await response.json());
      };
      this.latest = await Promise.race([request(), timeout]);
      this.expiresAt = this.now() + 60 * 60 * 1000;
    } catch (error) {
      // Keep the last confirmed release while offline; checks never create an error banner.
      this.expiresAt = this.now() + 5 * 60 * 1000;
      try {
        this.onError(error);
      } catch {
        // Diagnostics must not affect release checks or their retry backoff.
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export const applicationReleaseService = new ApplicationReleaseService();
