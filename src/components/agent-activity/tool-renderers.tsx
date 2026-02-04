/**
 * Re-exports from modular tool renderer components.
 * This file maintains backward compatibility with existing imports.
 */

// File reference extraction
export { extractFileReferences } from './tool-renderers/extract-file-references';
// Tool info rendering (main components)
export type {
  ToolCallGroupRendererProps,
  ToolInfoRendererProps,
  ToolSequenceGroupProps,
} from './tool-renderers/tool-info-renderer';
export {
  ToolCallGroupRenderer,
  ToolInfoRenderer,
  ToolSequenceGroup,
} from './tool-renderers/tool-info-renderer';
// Tool input rendering
export type { ToolInputRendererProps } from './tool-renderers/tool-input-renderer';
export { FilePathDisplay, ToolInputRenderer } from './tool-renderers/tool-input-renderer';
// Tool result rendering
export type { ToolResultContentRendererProps } from './tool-renderers/tool-result-renderer';
export { ToolResultContentRenderer } from './tool-renderers/tool-result-renderer';
