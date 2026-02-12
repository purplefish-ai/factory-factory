/**
 * Syntax highlighting for diff lines using refractor (Prism).
 *
 * Strategy:
 * 1. Reconstruct "new file" content from context + addition lines
 * 2. Reconstruct "old file" content from context + deletion lines
 * 3. Tokenize both using refractor
 * 4. Split HAST output by newlines into per-line token arrays
 * 5. Map tokens back to original diff line indices
 */

import type { CSSProperties } from 'react';
import { refractor } from 'refractor';
import type { DiffLine } from './types';

// ---------------------------------------------------------------------------
// Lightweight HAST types (only what we need from the refractor output)
// ---------------------------------------------------------------------------

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: { className?: string[] };
  children: HastNode[];
}

interface HastRoot {
  type: 'root';
  children: HastNode[];
}

type HastNode = HastText | HastElement;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single syntax token for rendering */
export interface SyntaxToken {
  content: string;
  /** Inline style (e.g. { color: 'hsl(...)' }) from the Prism theme */
  style?: CSSProperties;
}

/** Map from diff line index to its syntax tokens */
export type LineTokenMap = Map<number, SyntaxToken[]>;

/** Prism theme stylesheet — flat object mapping token names to CSS properties */
export type PrismStylesheet = Record<string, CSSProperties>;

// ---------------------------------------------------------------------------
// Language fallback map for languages not in refractor's default bundle
// ---------------------------------------------------------------------------

const LANGUAGE_FALLBACKS: Record<string, string> = {
  tsx: 'typescript',
  jsx: 'javascript',
  prisma: 'text',
  graphql: 'text',
};

function resolveLanguage(language: string): string | null {
  if (language === 'text' || language === 'plain' || language === 'plaintext') {
    return null;
  }
  try {
    refractor.highlight('', language);
    return language;
  } catch {
    const fallback = LANGUAGE_FALLBACKS[language];
    if (fallback && fallback !== 'text') {
      return resolveLanguage(fallback);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// HAST walking — split tokenized output by newlines into per-line tokens
// ---------------------------------------------------------------------------

function resolveStyle(
  classNames: string[],
  stylesheet: PrismStylesheet
): CSSProperties | undefined {
  const filtered = classNames.filter((c) => c !== 'token');
  if (filtered.length === 0) {
    return undefined;
  }

  let style: CSSProperties = {};
  let hasProps = false;

  for (const cls of filtered) {
    const entry = stylesheet[cls];
    if (entry) {
      style = { ...style, ...entry };
      hasProps = true;
    }
  }

  return hasProps ? style : undefined;
}

function processTextNode(
  node: HastText,
  classNames: string[],
  lines: SyntaxToken[][],
  stylesheet: PrismStylesheet
) {
  const parts = node.value.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      lines.push([]);
    }
    const part = parts[i];
    if (part && part.length > 0) {
      const style = resolveStyle(classNames, stylesheet);
      const currentLine = lines[lines.length - 1];
      if (currentLine) {
        currentLine.push({ content: part, style });
      }
    }
  }
}

function walkHastNode(
  node: HastNode,
  inheritedClassNames: string[],
  lines: SyntaxToken[][],
  stylesheet: PrismStylesheet
) {
  if (node.type === 'text') {
    processTextNode(node, inheritedClassNames, lines, stylesheet);
  } else if (node.type === 'element') {
    const classNames = [
      ...inheritedClassNames,
      ...((node.properties?.className as string[]) ?? []),
    ];
    for (const child of node.children) {
      walkHastNode(child, classNames, lines, stylesheet);
    }
  }
}

function splitHastByLine(root: HastRoot, stylesheet: PrismStylesheet): SyntaxToken[][] {
  const lines: SyntaxToken[][] = [[]];
  for (const child of root.children) {
    walkHastNode(child, [], lines, stylesheet);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Diff line collection
// ---------------------------------------------------------------------------

interface FileLineEntry {
  content: string;
  diffIndex: number;
}

function collectFileLines(diffLines: DiffLine[]): {
  newFileLines: FileLineEntry[];
  oldFileLines: FileLineEntry[];
} {
  const newFileLines: FileLineEntry[] = [];
  const oldFileLines: FileLineEntry[] = [];

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (!line) {
      continue;
    }
    if (line.type === 'context') {
      newFileLines.push({ content: line.content, diffIndex: i });
      oldFileLines.push({ content: line.content, diffIndex: i });
    } else if (line.type === 'addition') {
      newFileLines.push({ content: line.content, diffIndex: i });
    } else if (line.type === 'deletion') {
      oldFileLines.push({ content: line.content, diffIndex: i });
    }
  }

  return { newFileLines, oldFileLines };
}

// ---------------------------------------------------------------------------
// Tokenization helpers
// ---------------------------------------------------------------------------

function tokenizeAndMapLines(
  fileLines: FileLineEntry[],
  language: string,
  stylesheet: PrismStylesheet,
  tokenMap: LineTokenMap,
  lineTypeFilter?: string,
  diffLines?: DiffLine[]
) {
  if (fileLines.length === 0) {
    return;
  }

  const content = fileLines.map((l) => l.content).join('\n');
  const root = refractor.highlight(content, language) as unknown as HastRoot;
  const tokenLines = splitHastByLine(root, stylesheet);

  for (let i = 0; i < fileLines.length; i++) {
    const entry = fileLines[i];
    const tokens = tokenLines[i];
    if (!(entry && tokens)) {
      continue;
    }
    if (lineTypeFilter && diffLines) {
      if (diffLines[entry.diffIndex]?.type !== lineTypeFilter) {
        continue;
      }
    }
    tokenMap.set(entry.diffIndex, tokens);
  }
}

// ---------------------------------------------------------------------------
// Main tokenization function
// ---------------------------------------------------------------------------

/**
 * Tokenize diff lines using Prism, returning per-line syntax tokens.
 *
 * Reconstructs file content from the diff, tokenizes it as a whole
 * (preserving multi-line token context), then maps tokens back to
 * individual diff line indices.
 *
 * @param diffLines - Parsed diff lines
 * @param language - Language identifier (e.g. 'typescript', 'python')
 * @param stylesheet - Prism theme stylesheet (e.g. oneDark)
 * @returns Map from diff line index to syntax tokens, or null if highlighting is unavailable
 */
export function tokenizeDiffLines(
  diffLines: DiffLine[],
  language: string,
  stylesheet: PrismStylesheet
): LineTokenMap | null {
  const resolvedLanguage = resolveLanguage(language);
  if (!resolvedLanguage) {
    return null;
  }

  try {
    const tokenMap: LineTokenMap = new Map();
    const { newFileLines, oldFileLines } = collectFileLines(diffLines);

    // Tokenize "new file" content (context + additions)
    tokenizeAndMapLines(newFileLines, resolvedLanguage, stylesheet, tokenMap);

    // Tokenize "old file" content, but only apply to deletion lines
    tokenizeAndMapLines(
      oldFileLines,
      resolvedLanguage,
      stylesheet,
      tokenMap,
      'deletion',
      diffLines
    );

    return tokenMap;
  } catch {
    return null;
  }
}
