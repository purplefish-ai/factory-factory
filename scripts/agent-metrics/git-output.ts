// Pure parsers for the `git` output `collect.ts` reads. Every command runs with
// `-z` or in batch mode, so paths arrive verbatim: never quoted or escaped.

const commitMarker = '\u001e';

/**
 * Files touched by each commit in `git log -z --format=%x1e --name-only`
 * output, in log order. Each commit prints the marker and a NUL, then, when it
 * touched files, a newline and one NUL-terminated path per file.
 */
export function parseCommitFiles(output: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | undefined;
  for (const token of output.split('\0')) {
    if (token === commitMarker) {
      current = [];
      commits.push(current);
    } else if (current !== undefined && token.length > 0) {
      const path = current.length === 0 && token.startsWith('\n') ? token.slice(1) : token;
      if (path.length > 0) {
        current.push(path);
      }
    }
  }
  return commits;
}

export type TreeBlob = { objectId: string; path: string };

/** Files in `git ls-tree -r -z <commit>` output; submodules (`commit` entries) are skipped. */
export function parseTreeBlobs(output: string): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const entry of output.split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (match?.[1] && match[2]) {
      blobs.push({ objectId: match[1], path: match[2] });
    }
  }
  return blobs;
}

/**
 * Contents from `git cat-file --batch` output, in request order. Each object is
 * `<id> blob <bytes>\n<content>\n`; sizes are in bytes, so slice the buffer.
 */
export function parseBlobBatch(output: Buffer): string[] {
  const contents: string[] = [];
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.toString('utf8', offset, headerEnd === -1 ? output.length : headerEnd);
    const match = /^\S+ blob (\d+)$/.exec(header);
    if (headerEnd === -1 || !match?.[1]) {
      throw new Error(`Unexpected git cat-file output: ${header}`);
    }
    const start = headerEnd + 1;
    const end = start + Number(match[1]);
    contents.push(output.toString('utf8', start, end));
    offset = end + 1;
  }
  return contents;
}
