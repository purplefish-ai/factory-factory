import { SERVICE_CACHE_TTL_MS } from '@/backend/services/constants';

type CachedGitHubUsernameEntry = {
  value: string | null;
  fetchedAtMs: number;
  expiresAtMs: number;
};

export class GitHubUsernameCache {
  private cachedEntry: CachedGitHubUsernameEntry | null = null;

  constructor(
    private readonly githubService: { getAuthenticatedUsername(): Promise<string | null> }
  ) {}

  async getCachedUsername(): Promise<string | null> {
    const nowMs = Date.now();
    if (
      this.cachedEntry &&
      nowMs >= this.cachedEntry.fetchedAtMs &&
      nowMs < this.cachedEntry.expiresAtMs
    ) {
      return this.cachedEntry.value;
    }

    const value = await this.githubService.getAuthenticatedUsername();
    this.cachedEntry = {
      value: value ?? null,
      fetchedAtMs: nowMs,
      expiresAtMs: nowMs + SERVICE_CACHE_TTL_MS.ratchetAuthenticatedUsername,
    };
    return this.cachedEntry.value;
  }

  clear(): void {
    this.cachedEntry = null;
  }
}
