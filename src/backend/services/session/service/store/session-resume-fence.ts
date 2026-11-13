/** Resume authorization survives store eviction, but never permanent deletion. */
export class SessionResumeFences {
  private readonly fences = new Map<string, symbol>();

  capture(sessionId: string): () => boolean {
    let fence = this.fences.get(sessionId);
    if (!fence) {
      fence = Symbol();
      this.fences.set(sessionId, fence);
    }
    return () => this.fences.get(sessionId) === fence;
  }

  advance(sessionId: string): void {
    this.fences.set(sessionId, Symbol());
  }

  forget(sessionId: string): void {
    this.fences.delete(sessionId);
  }
}

export const sessionResumeFences = new SessionResumeFences();
