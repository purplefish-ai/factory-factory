import { describe, expect, it } from 'vitest';
import { parseBlobBatch, parseCommitFiles, parseTreeBlobs } from './git-output';

describe('git output parsers', () => {
  it('reads -z git log output, keeping spaces and non-ASCII characters in paths', () => {
    expect(
      parseCommitFiles(
        '\u001e\0\nsrc/a b.ts\0src/ü.ts\0\u001e\0\u001e\0\nREADME.md\0docs/new\nline.md\0'
      )
    ).toEqual([['src/a b.ts', 'src/ü.ts'], [], ['README.md', 'docs/new\nline.md']]);
    expect(parseCommitFiles('')).toEqual([]);
  });

  it('lists the blobs of a -z ls-tree, skipping submodules', () => {
    expect(
      parseTreeBlobs(
        [
          '100644 blob 1111111111111111111111111111111111111111\tsrc/a b.ts',
          '160000 commit 2222222222222222222222222222222222222222\tvendor/lib',
          '100755 blob 3333333333333333333333333333333333333333\tscripts/ü.sh',
          '',
        ].join('\0')
      )
    ).toEqual([
      { objectId: '1111111111111111111111111111111111111111', path: 'src/a b.ts' },
      { objectId: '3333333333333333333333333333333333333333', path: 'scripts/ü.sh' },
    ]);
  });

  it('splits cat-file --batch output by byte size, not character count', () => {
    const first = 'café\nline two\n';
    const second = '';
    const output = Buffer.concat([
      Buffer.from(`aaa blob ${Buffer.byteLength(first)}\n${first}\n`),
      Buffer.from(`bbb blob ${Buffer.byteLength(second)}\n${second}\n`),
    ]);
    expect(parseBlobBatch(output)).toEqual([first, second]);
    expect(() => parseBlobBatch(Buffer.from('ccc missing\n'))).toThrow(
      'Unexpected git cat-file output: ccc missing'
    );
  });
});
