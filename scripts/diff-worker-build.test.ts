import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

// Exercise browser package resolution: jsdom/Node imports alone would hide DOM-only exports.
describe('diff worker production bundle', () => {
  it('highlights without document or window in the worker global', async () => {
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const result = await build({
      root: projectRoot,
      logLevel: 'silent',
      build: {
        write: false,
        lib: {
          entry: fileURLToPath(
            new URL('../src/client/features/workspace/diff-highlight.worker.ts', import.meta.url)
          ),
          formats: ['iife'],
          name: 'DiffWorker',
        },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (output && 'output' in output) {
      const chunk = output.output.find((output) => output.type === 'chunk');
      expect(chunk).toBeDefined();
      let reply: unknown;
      const scope: {
        onmessage?: (event: { data: unknown }) => void;
        postMessage: (data: unknown) => void;
      } = {
        postMessage: (data) => {
          reply = data;
        },
      };
      runInNewContext(chunk?.code ?? '', { self: scope });
      scope.onmessage?.({
        data: {
          lines: [{ type: 'addition', content: 'const greeting = "hello";' }],
          language: 'typescript',
          theme: { keyword: { color: 'purple' } },
        },
      });
      expect(reply).toBeDefined();
      // Maps come from another JS realm, so compare iterable entries.
      const entries = Array.from(
        reply as Map<number, Array<{ content: string; style?: { color: string } }>>
      );
      expect(entries[0]?.[1].map((token) => token.content).join('')).toBe(
        'const greeting = "hello";'
      );
      expect(entries[0]?.[1]).toContainEqual({ content: 'const', style: { color: 'purple' } });
    } else {
      throw new Error('Expected a single worker build');
    }
  });
});
