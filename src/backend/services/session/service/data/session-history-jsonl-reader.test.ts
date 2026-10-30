import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNonEmptyJsonlLines } from './session-history-jsonl-reader';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-jsonl-reader-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(content: string | Buffer): string {
  const filePath = join(dir, 'history.jsonl');
  writeFileSync(filePath, content);
  return filePath;
}

async function readLines(filePath: string, chunkBytes?: number, containing?: string) {
  const lines: [string, number][] = [];
  const onError = vi.fn();
  await readNonEmptyJsonlLines({
    filePath,
    chunkBytes,
    containing,
    onLine: (line, lineNumber) => {
      lines.push([line, lineNumber]);
    },
    onError,
  });
  expect(onError).not.toHaveBeenCalled();
  return lines;
}

describe('readNonEmptyJsonlLines', () => {
  it('splits lines across every chunk boundary, including inside multi-byte characters', async () => {
    const lines = ['{"text":"héllo 👋 wörld"}', '{"text":"日本語のテキスト"}', '{"n":3}'];
    const filePath = writeFile(`${lines.join('\n')}\n`);
    // Chunk sizes of 1..7 bytes split lines and every multi-byte character at
    // some point; 1 MiB reads the whole file as one chunk.
    for (const chunkBytes of [1, 2, 3, 5, 7, 1024 * 1024]) {
      await expect(readLines(filePath, chunkBytes)).resolves.toEqual([
        [lines[0], 1],
        [lines[1], 2],
        [lines[2], 3],
      ]);
    }
  });

  it('handles CRLF, empty and whitespace-only lines, and a final line without a newline', async () => {
    const filePath = writeFile('{"a":1}\r\n\r\n   \n{"b":2}\n\n{"c":3}');
    for (const chunkBytes of [1, 4, 64]) {
      await expect(readLines(filePath, chunkBytes)).resolves.toEqual([
        ['{"a":1}', 1],
        ['{"b":2}', 4],
        ['{"c":3}', 6],
      ]);
    }
  });

  it('reads an empty file and a file with only newlines as no lines', async () => {
    await expect(readLines(writeFile(''))).resolves.toEqual([]);
    await expect(readLines(writeFile('\n\r\n\n'))).resolves.toEqual([]);
  });

  it('reports read and callback errors through onError', async () => {
    const onError = vi.fn();
    await readNonEmptyJsonlLines({
      filePath: join(dir, 'missing.jsonl'),
      onLine: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOENT' }));

    const failure = new Error('bad line');
    const callbackError = vi.fn();
    await readNonEmptyJsonlLines({
      filePath: writeFile('{"a":1}\n'),
      onLine: () => Promise.reject(failure),
      onError: callbackError,
    });
    expect(callbackError).toHaveBeenCalledWith(failure);
  });
});

describe('readNonEmptyJsonlLines with containing', () => {
  const marker = '<!-- factory-factory-pr-event:delivery-1 -->';

  it('passes on only matching lines with their line numbers, at any chunk size', async () => {
    const lines = [
      JSON.stringify({ text: 'no match ✓' }),
      '',
      JSON.stringify({ text: `${marker}\nPR update ✓` }),
      JSON.stringify({ text: 'still no match' }),
      JSON.stringify({ text: `before ${marker} after ${marker}` }),
    ];
    const filePath = writeFile(lines.join('\r\n'));
    for (const chunkBytes of [1, 3, 17, 1024 * 1024]) {
      await expect(readLines(filePath, chunkBytes, marker)).resolves.toEqual([
        [lines[2], 3],
        [lines[4], 5],
      ]);
    }
  });

  it('matches text the way JSON.stringify escapes it', async () => {
    const text = 'quote " and backslash \\';
    const filePath = writeFile(`${JSON.stringify({ other: 1 })}\n${JSON.stringify({ text })}`);
    await expect(readLines(filePath, undefined, text)).resolves.toEqual([
      [JSON.stringify({ text }), 2],
    ]);
  });

  it('passes on nothing when the text is absent and reports unreadable files', async () => {
    await expect(readLines(writeFile('{"a":1}\n'), undefined, marker)).resolves.toEqual([]);
    const onError = vi.fn();
    await readNonEmptyJsonlLines({
      filePath: join(dir, 'missing.jsonl'),
      containing: marker,
      onLine: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOENT' }));
  });
});
