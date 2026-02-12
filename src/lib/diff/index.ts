/**
 * Shared diff parsing and rendering utilities
 *
 * This module provides unified diff parsing and styling utilities used across:
 * - Workspace diff viewer (detailed line-by-line with line numbers)
 * - PR detail panel (file-based with hunks)
 */

export {
  calculateLineNumberWidth,
  parseDetailedDiff,
  parseFileDiff,
} from './parse';
export {
  getDiffLineBackground,
  getDiffLinePrefix,
  getDiffLineTextColor,
  getSimpleDiffLineClassName,
  getSimpleDiffLinePrefix,
} from './styles';
export type { LineTokenMap, PrismStylesheet, SyntaxToken } from './syntax-highlight';
export { tokenizeDiffLines } from './syntax-highlight';
export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffLineType,
  LineNumber,
  SimpleDiffLine,
  SimpleDiffLineType,
} from './types';
