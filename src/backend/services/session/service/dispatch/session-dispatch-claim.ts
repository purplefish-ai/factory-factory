/** Remembers queue progress requested while a provider receipt still owns dispatch. */
export class SessionDispatchClaim {
  private readonly claims = new Map<string, { token: number; requested: boolean }>();
  private nextToken = 1;

  request(sessionId: string): boolean {
    const claim = this.claims.get(sessionId);
    if (!claim) {
      return false;
    }
    claim.requested = true;
    return true;
  }

  reserve(sessionId: string): number {
    const token = this.nextToken++;
    this.claims.set(sessionId, { token, requested: false });
    return token;
  }

  release(sessionId: string, token: number): boolean {
    const claim = this.claims.get(sessionId);
    if (claim?.token !== token) {
      return false;
    }
    this.claims.delete(sessionId);
    return claim.requested;
  }

  reset(sessionId: string): void {
    this.claims.delete(sessionId);
  }
}
