export class RunScriptOutputBuffer {
  readonly buffers = new Map<string, string>();
  readonly listeners = new Map<string, Set<(data: string) => void>>();

  constructor(private readonly maxBufferSize: number) {}

  set(workspaceId: string, output: string): void {
    this.buffers.set(workspaceId, this.truncate(output));
  }

  append(workspaceId: string, output: string): void {
    const currentBuffer = this.buffers.get(workspaceId) ?? '';
    this.buffers.set(workspaceId, this.truncate(currentBuffer + output));

    const listeners = this.listeners.get(workspaceId);
    if (listeners) {
      for (const listener of listeners) {
        listener(output);
      }
    }
  }

  get(workspaceId: string): string {
    return this.buffers.get(workspaceId) ?? '';
  }

  clearBuffer(workspaceId: string): void {
    this.buffers.delete(workspaceId);
  }

  subscribe(workspaceId: string, listener: (data: string) => void): () => void {
    let listeners = this.listeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(workspaceId, listeners);
    }
    listeners.add(listener);

    return () => {
      const currentListeners = this.listeners.get(workspaceId);
      if (currentListeners) {
        currentListeners.delete(listener);
        if (currentListeners.size === 0) {
          this.listeners.delete(workspaceId);
        }
      }
    };
  }

  evict(workspaceId: string): void {
    this.buffers.delete(workspaceId);
    this.listeners.delete(workspaceId);
  }

  clear(): void {
    this.buffers.clear();
    this.listeners.clear();
  }

  private truncate(output: string): string {
    if (output.length <= this.maxBufferSize) {
      return output;
    }
    return output.slice(-this.maxBufferSize);
  }
}
