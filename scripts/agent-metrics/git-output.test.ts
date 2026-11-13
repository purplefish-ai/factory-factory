import { describe, expect, it } from 'vitest';
import { parseBlobBatch, parseCommitFiles, parseTreeBlobs } from './git-output';

const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const third = 'c'.repeat(40);

describe('git output parsers', () => {
  it('reads -z git log output, keeping spaces and non-ASCII characters in paths', () => {
    expect(
      parseCommitFiles(
        Buffer.from(
          `\u001e${first}\0\nsrc/a b.ts\0src/ü.ts\0\u001e${second}\0\u001e${third}\0\nREADME.md\0docs/new\nline.md\0`
        )
      )
    ).toEqual([['src/a b.ts', 'src/ü.ts'], [], ['README.md', 'docs/new\nline.md']]);
    expect(parseCommitFiles(Buffer.from(''))).toEqual([]);
  });

  it('reads a path named with the commit marker as a path', () => {
    expect(parseCommitFiles(Buffer.from(`\u001e${first}\0\n\u001e\0a.ts\0`))).toEqual([
      ['\u001e', 'a.ts'],
    ]);
  });

  it('keeps bytes that are not UTF-8 as octal escapes', () => {
    const invalid = Buffer.concat([Buffer.from('src/'), Buffer.from([0xff]), Buffer.from('.ts')]);
    expect(
      parseCommitFiles(
        Buffer.concat([Buffer.from(`\u001e${first}\0\n`), invalid, Buffer.from('\0')])
      )
    ).toEqual([['src/\\377.ts']]);
    expect(
      parseTreeBlobs(
        Buffer.concat([Buffer.from(`100644 blob ${first}\t`), invalid, Buffer.from('\0')])
      )
    ).toEqual([{ objectId: first, path: 'src/\\377.ts' }]);
  });

  it('lists the blobs of a -z ls-tree, skipping submodules', () => {
    expect(
      parseTreeBlobs(
        Buffer.from(
          [
            '100644 blob 1111111111111111111111111111111111111111\tsrc/a b.ts',
            '160000 commit 2222222222222222222222222222222222222222\tvendor/lib',
            '100755 blob 3333333333333333333333333333333333333333\tscripts/ü.sh',
            '',
          ].join('\0')
        )
      )
    ).toEqual([
      { objectId: '1111111111111111111111111111111111111111', path: 'src/a b.ts' },
      { objectId: '3333333333333333333333333333333333333333', path: 'scripts/ü.sh' },
    ]);
  });

  it('splits cat-file --batch output by byte size, not character count', () => {
    const content = 'café\nline two\n';
    const empty = '';
    const output = Buffer.concat([
      Buffer.from(`aaa blob ${Buffer.byteLength(content)}\n${content}\n`),
      Buffer.from(`bbb blob ${Buffer.byteLength(empty)}\n${empty}\n`),
    ]);
    expect(parseBlobBatch(output)).toEqual([content, empty]);
    expect(() => parseBlobBatch(Buffer.from('ccc missing\n'))).toThrow(
      'Unexpected git cat-file output: ccc missing'
    );
  });
});
