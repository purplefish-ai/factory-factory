import { spawn } from 'node:child_process';
import type { TestCommandResult } from './auto-iteration.types';

const MAX_OUTPUT_LINES = 200;
// Cap each stream at 5 MB to prevent unbounded memory growth on noisy test runs
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;

/** Run a test command in a worktree and capture output. */
export function runTestCommand(
  worktreePath: string,
  command: string,
  timeoutSeconds: number,
  onChunk?: (text: string) => void
): Promise<TestCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exited = false;

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (Buffer.byteLength(stdout) > MAX_BUFFER_BYTES) {
        stdout = Buffer.from(stdout).subarray(-MAX_BUFFER_BYTES).toString('utf-8');
      }
      onChunk?.(text);
    });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (Buffer.byteLength(stderr) > MAX_BUFFER_BYTES) {
        stderr = Buffer.from(stderr).subarray(-MAX_BUFFER_BYTES).toString('utf-8');
      }
      onChunk?.(text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutSeconds * 1000);

    child.on('close', (code) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}\n${err.message}`,
        exitCode: 1,
        timedOut,
      });
    });
  });
}

/**
 * Truncate test output to avoid flooding the LLM context.
 * Keeps the last N lines plus summary lines extracted from earlier output.
 */
export function truncateTestOutput(raw: string, maxLines = MAX_OUTPUT_LINES): string {
  const lines = raw.split('\n');
  if (lines.length <= maxLines) {
    return raw;
  }

  const summaryPatterns = /pass|fail|error|total|coverage|%|result|summary|assert/i;
  const summaryLines = lines.filter((l) => summaryPatterns.test(l));

  const tail = lines.slice(-maxLines);
  const earlySummary = summaryLines.filter((l) => !tail.includes(l));

  return [
    `[... ${lines.length - maxLines} lines truncated ...]`,
    ...earlySummary.slice(0, 20),
    '---',
    ...tail,
  ].join('\n');
}
