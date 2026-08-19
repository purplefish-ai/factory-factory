import type { ChildProcess } from 'node:child_process';

export class AcpRuntimeIncarnations<TRuntime extends { installed: boolean }> {
  private readonly currentBySessionId = new Map<string, TRuntime>();
  private readonly byChild = new WeakMap<ChildProcess, TRuntime>();

  begin(sessionId: string, runtime: TRuntime): TRuntime {
    this.currentBySessionId.set(sessionId, runtime);
    return runtime;
  }

  recordChild(child: ChildProcess, runtime: TRuntime): void {
    this.byChild.set(child, runtime);
  }

  getForChild(child: ChildProcess): TRuntime | undefined {
    return this.byChild.get(child);
  }

  isCurrent(sessionId: string, runtime: TRuntime): boolean {
    return this.currentBySessionId.get(sessionId) === runtime;
  }

  clearUninstalled(sessionId: string, runtime: TRuntime): void {
    if (!runtime.installed) {
      this.clearRuntime(sessionId, runtime);
    }
  }

  clearForChild(sessionId: string, child: ChildProcess | undefined): void {
    const runtime = child ? this.byChild.get(child) : undefined;
    if (runtime) {
      this.clearRuntime(sessionId, runtime);
    }
  }

  clear(): void {
    this.currentBySessionId.clear();
  }

  private clearRuntime(sessionId: string, runtime: TRuntime): void {
    if (this.isCurrent(sessionId, runtime)) {
      this.currentBySessionId.delete(sessionId);
    }
  }
}
