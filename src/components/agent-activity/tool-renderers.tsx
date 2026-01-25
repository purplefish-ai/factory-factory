'use client';

/**
 * Tool rendering components for agent activity
 * Adds file links for Read/Edit tool results
 */

import { FileCode, FileText, Search } from 'lucide-react';
import { useState } from 'react';
import { extractToolInfo } from '../chat/message-utils';
import type { ClaudeMessage, ToolInfo } from '../chat/types';
import { extractFileReference, type FileReference } from './types';

interface FileReferenceLinkProps {
  fileRef: FileReference;
}

/** Render a file reference as a clickable link */
function FileReferenceLink({ fileRef }: FileReferenceLinkProps) {
  // For now, just display the file path. In the future, this could link to a file viewer.
  const lineInfo = fileRef.lineNumber
    ? `:${fileRef.lineNumber}${fileRef.lineCount ? `-${fileRef.lineNumber + fileRef.lineCount}` : ''}`
    : '';

  return (
    <span className="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer">
      <FileCode className="h-3 w-3" />
      <span className="font-mono">
        {fileRef.displayPath}
        {lineInfo}
      </span>
    </span>
  );
}

/** Get icon for tool type */
function getToolIcon(toolName: string) {
  switch (toolName) {
    case 'Read':
      return <FileText className="h-3 w-3" />;
    case 'Edit':
    case 'Write':
      return <FileCode className="h-3 w-3" />;
    case 'Grep':
    case 'Glob':
      return <Search className="h-3 w-3" />;
    default:
      return null;
  }
}

interface ToolUseRendererProps {
  info: ToolInfo;
  expanded: boolean;
  onToggle: () => void;
}

/** Render a tool_use block */
function ToolUseRenderer({ info, expanded, onToggle }: ToolUseRendererProps) {
  const icon = getToolIcon(info.name || '');
  const fileRef = info.name ? extractFileReference(info.name, info.input) : null;

  return (
    <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded border border-blue-200 dark:border-blue-800">
      <button type="button" onClick={onToggle} className="flex items-center gap-2 w-full text-left">
        {icon}
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">{info.name}</span>
        {fileRef && <FileReferenceLink fileRef={fileRef} />}
        <span className="text-xs text-blue-500 ml-auto">{expanded ? '[-]' : '[+]'}</span>
      </button>
      {expanded && info.input && (
        <pre className="mt-2 text-xs bg-blue-100 dark:bg-blue-900/50 p-2 rounded overflow-x-auto">
          {JSON.stringify(info.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

interface ToolResultRendererProps {
  info: ToolInfo;
  expanded: boolean;
  onToggle: () => void;
}

/** Render a tool_result block */
function ToolResultRenderer({ info, expanded, onToggle }: ToolResultRendererProps) {
  const resultText = info.result || '';
  const isTruncated = resultText.length > 500;

  const containerClass = info.isError
    ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
    : 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800';

  const textClass = info.isError
    ? 'text-red-700 dark:text-red-300'
    : 'text-green-700 dark:text-green-300';

  const preClass = info.isError
    ? 'bg-red-100 dark:bg-red-900/50'
    : 'bg-green-100 dark:bg-green-900/50';

  return (
    <div className={`p-3 rounded border ${containerClass}`}>
      <button type="button" onClick={onToggle} className="flex items-center gap-2 w-full text-left">
        <span className={`text-xs font-medium ${textClass}`}>
          {info.isError ? 'Error' : 'Result'}
        </span>
        {isTruncated && (
          <span className="text-xs text-muted-foreground ml-auto">{expanded ? '[-]' : '[+]'}</span>
        )}
      </button>
      <pre className={`mt-2 text-xs p-2 rounded overflow-x-auto ${preClass}`}>
        {expanded || !isTruncated ? resultText : `${resultText.slice(0, 500)}...`}
      </pre>
    </div>
  );
}

interface ToolInfoRendererProps {
  info: ToolInfo;
  projectSlug?: string;
}

/** Render tool info (works for both tool_use and tool_result) */
export function ToolInfoRenderer({ info }: ToolInfoRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const onToggle = () => setExpanded(!expanded);

  if (info.type === 'tool_use') {
    return <ToolUseRenderer info={info} expanded={expanded} onToggle={onToggle} />;
  }

  return <ToolResultRenderer info={info} expanded={expanded} onToggle={onToggle} />;
}

interface ToolCallGroupRendererProps {
  messages: ClaudeMessage[];
  projectSlug?: string;
}

/** Grouped tool calls renderer - shows multiple tool calls collapsed */
export function ToolCallGroupRenderer({ messages, projectSlug }: ToolCallGroupRendererProps) {
  const [expanded, setExpanded] = useState(false);

  // Extract tool info from all messages
  const toolInfos = messages.map(extractToolInfo).filter((t): t is ToolInfo => t !== null);
  const toolUses = toolInfos.filter((t) => t.type === 'tool_use');
  const toolResults = toolInfos.filter((t) => t.type === 'tool_result');
  const hasErrors = toolResults.some((t) => t.isError);

  // Get unique tool names
  const toolNames = [...new Set(toolUses.map((t) => t.name).filter(Boolean))];
  const summary =
    toolNames.length <= 3 ? toolNames.join(', ') : `${toolNames.slice(0, 3).join(', ')}...`;

  // Get file references for summary
  const fileRefs = toolUses
    .filter((t): t is ToolInfo & { name: string } => Boolean(t.name))
    .map((t) => extractFileReference(t.name, t.input))
    .filter((ref): ref is FileReference => ref !== null);

  const borderClass = hasErrors
    ? 'border-red-200 dark:border-red-800'
    : 'border-blue-200 dark:border-blue-800';

  const headerBgClass = hasErrors
    ? 'bg-red-50 dark:bg-red-950/30'
    : 'bg-blue-50 dark:bg-blue-950/30';

  const textClass = hasErrors
    ? 'text-red-700 dark:text-red-300'
    : 'text-blue-700 dark:text-blue-300';

  return (
    <div className={`rounded-lg border ${borderClass}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full p-3 flex items-center justify-between text-left ${headerBgClass} rounded-t-lg ${!expanded ? 'rounded-b-lg' : ''}`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-medium ${textClass}`}>
            {toolUses.length} tool call{toolUses.length !== 1 ? 's' : ''}: {summary}
          </span>
          {hasErrors && (
            <span className="text-xs px-1.5 py-0.5 bg-red-200 dark:bg-red-800 text-red-800 dark:text-red-200 rounded">
              error
            </span>
          )}
          {fileRefs.length > 0 && fileRefs.length <= 2 && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <FileCode className="h-3 w-3" />
              {fileRefs.map((ref) => ref.displayPath).join(', ')}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? '[-]' : '[+]'}</span>
      </button>
      {expanded && (
        <div className="p-2 space-y-2 bg-muted/20">
          {toolInfos.map((info) => (
            <ToolInfoRenderer
              key={info.id || `${info.type}-${info.name}`}
              info={info}
              projectSlug={projectSlug}
            />
          ))}
        </div>
      )}
    </div>
  );
}
