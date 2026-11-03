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
 * single block.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// Link reference and footnote definitions apply to the whole document.
const DEFINITION = /\[[^\]]*\]:/;
// HTML block start conditions 1-5 continue across blank lines.
const SPANNING_HTML = /<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

interface Fence {
  marker: string;
  length: number;
}

function openFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  const run = match?.[1];
  if (!run) {
    return null;
  }
  // A backtick fence's info string cannot contain backticks (that is inline code).
  if (run.startsWith('`') && match[2]?.includes('`')) {
    return null;
  }
  return { marker: run.charAt(0), length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const run = FENCE_CLOSE.exec(line)?.[1];
  return run !== undefined && run.charAt(0) === fence.marker && run.length >= fence.length;
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
    }
    state.previousBlank = false;
    return false;
  }
  if (line.trim() === '') {
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

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const startsBlock = scanLine(line, state);
    if (startsBlock === null) {
      return [markdown];
    }
    if (startsBlock) {
      blocks.push(markdown.slice(blockStart, lineStart));
      blockStart = lineStart;
    }
    lineStart += rawLine.length + 1;
  }

  blocks.push(markdown.slice(blockStart));
  return blocks;
}
