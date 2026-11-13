import { z } from 'zod';

const stableVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const releaseSchema = z.object({ version: stableVersion });
const CURRENT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Only stable releases on npm's latest tag should prompt an upgrade. */
export function isNewerRelease(current: string, latest: string): boolean {
  const parsed = CURRENT_VERSION.exec(current);
  if (!(parsed && stableVersion.safeParse(latest).success)) {
    return false;
  }
  const installed = parsed.slice(1, 4).map(Number);
  const available = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (available[i] !== installed[i]) {
      return (available[i] ?? 0) > (installed[i] ?? 0);
    }
  }
  return Boolean(parsed[4]);
}

/** Shared across clients; checks run on demand, never on the startup path. */
export class FactoryReleaseChecker {
  private latest: string | null = null;
  private latestRegistryUrl: string | null = null;
  private expiresAt = 0;
  private pending: Promise<string | null> | null = null;

  getLatestVersion(
    onError?: (error: unknown) => void,
    registryUrl = 'https://registry.npmjs.org'
  ): Promise<string | null> {
    if (this.pending !== null) {
      return this.pending;
    }
    if (registryUrl !== this.latestRegistryUrl) {
      // A version cached from another registry says nothing about this one.
      this.latest = null;
      this.expiresAt = 0;
      this.latestRegistryUrl = registryUrl;
    }
    if (Date.now() < this.expiresAt) {
      return Promise.resolve(this.latest);
    }
    this.pending = this.fetchLatest(registryUrl, onError).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetchLatest(
    registryUrl: string,
    onError?: (error: unknown) => void
  ): Promise<string | null> {
    try {
      const response = await fetch(`${registryUrl}/factory-factory/latest`, {
        signal: AbortSignal.timeout(3000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Registry unavailable (HTTP ${response.status})`);
      }
      const release = releaseSchema.parse(await response.json());
      this.latest = release.version;
      this.expiresAt = Date.now() + 60 * 60 * 1000;
    } catch (error) {
      // An optional update check must never block use of Factory or discard known data.
      this.expiresAt = Date.now() + 5 * 60 * 1000;
      try {
        onError?.(error);
      } catch {
        // Diagnostics are best-effort and must not bypass the failure backoff.
      }
    }
    return this.latest;
  }
}

export const factoryReleaseChecker = new FactoryReleaseChecker();
