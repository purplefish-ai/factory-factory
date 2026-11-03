/**
 * Cheap top-level Markdown block splitter for streaming renders.
 *
 * Splitting lets a streaming message re-parse only its last, growing block.
 * Blocks are contiguous slices, so `blocks.join('') === markdown`. A split is
 * made only where rendering each block independently produces the same output
 * as rendering the whole document: before an unindented, non-list line that
 * follows a blank line outside a top-level fenced code block. Indented lines
 * may continue list items or indented code, and list markers may continue (and
 * loosen) the preceding list, so neither starts a new block.
 *
 * Some constructs are document-wide or may contain blank lines. Link reference
 * and footnote definitions, and HTML blocks that end only at an explicit
 * terminator (comments, `<pre>`, `<script>`, and similar), make the whole text a
 * single block. So does an indented fence that may belong to a list item when a
 * later line would end it only under that reading.
 */

const LINE_BREAK = /\r\n|\r|\n/g;
const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FENCE_LIKE = /^[ \t]*(?:`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// Blockquote and list markers may precede a block inside a container.
const CONTAINER_PREFIX = String.raw`^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])[ \t])*`;
// Link reference and footnote definitions apply to the whole document.
const DEFINITION = new RegExp(String.raw`${CONTAINER_PREFIX}\[[^\]]*\]:`);
// HTML block start conditions 1-5 continue across blank lines.
const SPANNING_HTML = new RegExp(
  String.raw`${CONTAINER_PREFIX}<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[)`,
  'i'
);

interface Fence {
  marker: string;
  length: number;
  indent: number;
}

function openFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  const run = match?.[2];
  if (!run) {
    return null;
  }
  // A backtick fence's info string cannot contain backticks (that is inline code).
  if (run.startsWith('`') && match[3]?.includes('`')) {
    return null;
  }
  return { marker: run.charAt(0), length: run.length, indent: match[1]?.length ?? 0 };
}

function closesFence(line: string, fence: Fence): boolean {
  const run = FENCE_CLOSE.exec(line)?.[1];
  return run !== undefined && run.charAt(0) === fence.marker && run.length >= fence.length;
}

/**
 * An indented fence is top-level or inside a list item. The readings agree
 * until a non-blank line is less indented than the fence, or a fence-like line
 * is too indented to close a top-level fence.
 */
function isAmbiguousFenceLine(line: string, fence: Fence): boolean {
  if (fence.indent === 0 || BLANK.test(line)) {
    return false;
  }
  const indent = line.length - line.replace(/^ */, '').length;
  return indent < fence.indent || FENCE_LIKE.test(line);
}

function startsIndependentBlock(line: string): boolean {
  const first = line.charAt(0);
  return first !== ' ' && first !== '\t' && !LIST_ITEM.test(line);
}

interface ScanState {
  fence: Fence | null;
  previousBlank: boolean;
  hasContent: boolean;
}

/** Whether a block starts at this line; `null` when no split is safe for the text. */
function scanLine(line: string, state: ScanState): boolean | null {
  if (state.fence) {
    if (closesFence(line, state.fence)) {
      state.fence = null;
    } else if (isAmbiguousFenceLine(line, state.fence)) {
      return null;
    }
    state.previousBlank = false;
    return false;
  }
  if (BLANK.test(line)) {
    state.previousBlank = true;
    return false;
  }
  if (DEFINITION.test(line) || SPANNING_HTML.test(line)) {
    return null;
  }
  const startsBlock = state.previousBlank && state.hasContent && startsIndependentBlock(line);
  state.fence = openFence(line);
  state.previousBlank = false;
  state.hasContent = true;
  return startsBlock;
}

export function splitMarkdownBlocks(markdown: string): string[] {
  const state: ScanState = { fence: null, previousBlank: false, hasContent: false };
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;

  const breaks = [...markdown.matchAll(LINE_BREAK)];
  for (let index = 0; index <= breaks.length; index++) {
    const lineBreak = breaks[index];
    const lineEnd = lineBreak ? lineBreak.index : markdown.length;
    const startsBlock = scanLine(markdown.slice(lineStart, lineEnd), state);
    if (startsBlock === null) {
      return [markdown];
    }
    if (startsBlock) {
      blocks.push(markdown.slice(blockStart, lineStart));
      blockStart = lineStart;
    }
    lineStart = lineEnd + (lineBreak?.[0].length ?? 0);
  }

  blocks.push(markdown.slice(blockStart));
  return blocks;
}
