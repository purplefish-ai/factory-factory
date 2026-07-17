export const WORKSPACE_LOG_OUTPUT_MAX_CHARS = 512 * 1024;
export const TERMINAL_OUTPUT_MAX_CHARS = 128 * 1024;

export const WORKSPACE_LOG_TRUNCATION_MARKER = '[Earlier output truncated]\n';
export const TERMINAL_TRUNCATION_MARKER = '\r\n[Earlier terminal output truncated]\r\n';

interface RollingOutputOptions {
  maxChars: number;
  truncationMarker: string;
}

export class RollingOutputBuffer {
  private chunks: string[] = [];
  private startIndex = 0;
  private bufferedChars = 0;
  private truncated = false;
  private readonly maxChars: number;
  private readonly boundedMarker: string;

  constructor({ maxChars, truncationMarker }: RollingOutputOptions) {
    this.maxChars = Math.max(0, maxChars);
    this.boundedMarker = truncationMarker.slice(0, this.maxChars);
  }

  append(next: string): void {
    if (this.maxChars === 0 || next.length === 0) {
      return;
    }

    this.chunks.push(next);
    this.bufferedChars += next.length;

    if (!this.truncated && this.bufferedChars > this.maxChars) {
      this.truncated = true;
    }

    const bodyCapacity = this.truncated ? this.maxChars - this.boundedMarker.length : this.maxChars;
    this.trimTo(bodyCapacity);
  }

  toString(): string {
    const body = this.bufferedChars === 0 ? '' : this.chunks.slice(this.startIndex).join('');
    return this.truncated ? this.boundedMarker + body : body;
  }

  private trimTo(maxBodyChars: number): void {
    while (this.bufferedChars > maxBodyChars && this.startIndex < this.chunks.length) {
      const overflow = this.bufferedChars - maxBodyChars;
      const firstChunk = this.chunks[this.startIndex];
      if (firstChunk === undefined) {
        this.resetChunks();
        return;
      }

      if (firstChunk.length <= overflow) {
        this.bufferedChars -= firstChunk.length;
        this.chunks[this.startIndex] = '';
        this.startIndex += 1;
        this.compactIfNeeded();
        continue;
      }

      this.chunks[this.startIndex] = firstChunk.slice(overflow);
      this.bufferedChars -= overflow;
    }
  }

  private compactIfNeeded(): void {
    if (this.startIndex < 64 || this.startIndex * 2 < this.chunks.length) {
      return;
    }

    this.chunks = this.chunks.slice(this.startIndex);
    this.startIndex = 0;
  }

  private resetChunks(): void {
    this.chunks = [];
    this.startIndex = 0;
    this.bufferedChars = 0;
  }
}

export function appendToRollingOutput(
  current: string,
  next: string,
  { maxChars, truncationMarker }: RollingOutputOptions
): string {
  if (maxChars <= 0) {
    return '';
  }

  const wasTruncated = current.startsWith(truncationMarker);
  const currentBody = wasTruncated ? current.slice(truncationMarker.length) : current;
  const combinedBody = currentBody + next;

  if (!wasTruncated && combinedBody.length <= maxChars) {
    return combinedBody;
  }

  const boundedMarker = truncationMarker.slice(0, maxChars);
  const maxBodyChars = maxChars - boundedMarker.length;
  if (maxBodyChars <= 0) {
    return boundedMarker;
  }

  return boundedMarker + combinedBody.slice(-maxBodyChars);
}

export function trimRollingOutput(output: string, options: RollingOutputOptions): string {
  return appendToRollingOutput('', output, options);
}
