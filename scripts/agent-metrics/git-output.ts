// Pure parsers for the `git` output `collect.ts` reads. Every command runs with
// `-z` or in batch mode, so paths arrive verbatim: never quoted or escaped.

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A path from raw `git` bytes. Git paths can hold bytes that are not UTF-8;
 * like `decodeGitPath`, keep those as octal escapes rather than replacing them.
 */
function decodePath(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return [...bytes]
      .map((byte) =>
        byte >= 0x20 && byte < 0x7f
          ? String.fromCharCode(byte)
          : `\\${byte.toString(8).padStart(3, '0')}`
      )
      .join('');
  }
}

function splitNul(output: Buffer): Buffer[] {
  const tokens: Buffer[] = [];
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    tokens.push(output.subarray(start, end));
    start = end + 1;
  }
  if (start < output.length) {
    tokens.push(output.subarray(start));
  }
  return tokens;
}

/** The `--format` that `parseCommitFiles` expects: a record separator and the commit hash. */
export const commitFilesFormat = '%x1e%H';
const recordSeparator = 0x1e;

function isCommitHeader(token: Buffer): boolean {
  return token[0] === recordSeparator && /^[0-9a-f]{40,64}$/.test(token.toString('latin1', 1));
}

/**
 * Files touched by each commit in `git log -z --format=%x1e%H --name-only`
 * output, in log order. Each commit prints its header and a NUL, then, when it
 * touched files, a newline and one NUL-terminated path per file.
 */
export function parseCommitFiles(output: Buffer): string[][] {
  const commits: string[][] = [];
  let current: string[] | undefined;
  let first = false;
  for (const token of splitNul(output)) {
    if (isCommitHeader(token)) {
      current = [];
      commits.push(current);
      first = true;
    } else if (current !== undefined) {
      const path = first && token[0] === 0x0a ? token.subarray(1) : token;
      first = false;
      if (path.length > 0) {
        current.push(decodePath(path));
      }
    }
  }
  return commits;
}

export type TreeBlob = { objectId: string; path: string };

/** Files in `git ls-tree -r -z <commit>` output; submodules (`commit` entries) are skipped. */
export function parseTreeBlobs(output: Buffer): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const entry of splitNul(output)) {
    const tab = entry.indexOf(0x09);
    const header = /^\d+ blob ([0-9a-f]+)$/.exec(entry.toString('latin1', 0, Math.max(tab, 0)));
    if (tab !== -1 && header?.[1]) {
      blobs.push({ objectId: header[1], path: decodePath(entry.subarray(tab + 1)) });
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
