'use client';

/**
 * Tool rendering components
 */

import { useState } from 'react';
import { extractToolInfo } from './message-utils';
import type { ClaudeMessage, ToolInfo } from './types';

/** Render tool info (works for both tool_use and tool_result) */
export function ToolInfoRenderer({ info }: { info: ToolInfo }) {
  const [expanded, setExpanded] = useState(false);

  if (info.type === 'tool_use') {
    return (
      <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded border border-blue-200 dark:border-blue-800">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left"
        >
          <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
            Tool: {info.name}
          </span>
          <span className="text-xs text-blue-500">{expanded ? '[-]' : '[+]'}</span>
        </button>
        {expanded && info.input && (
          <pre className="mt-2 text-xs bg-blue-100 dark:bg-blue-900/50 p-2 rounded overflow-x-auto">
            {JSON.stringify(info.input, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  // Tool result
  const resultText = info.result || '';
  const isTruncated = resultText.length > 500;

  return (
    <div
      className={`p-3 rounded border ${
        info.isError
          ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
          : 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span
          className={`text-xs font-medium ${info.isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
        >
          {info.isError ? 'Error' : 'Result'}
        </span>
        {isTruncated && (
          <span className="text-xs text-muted-foreground">{expanded ? '[-]' : '[+]'}</span>
        )}
      </button>
      <pre
        className={`mt-2 text-xs p-2 rounded overflow-x-auto ${
          info.isError ? 'bg-red-100 dark:bg-red-900/50' : 'bg-green-100 dark:bg-green-900/50'
        }`}
      >
        {expanded || !isTruncated ? resultText : `${resultText.slice(0, 500)}...`}
      </pre>
    </div>
  );
}

/** Grouped tool calls renderer - shows multiple tool calls collapsed */
export function ToolCallGroupRenderer({ messages }: { messages: ClaudeMessage[] }) {
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

  return (
    <div
      className={`rounded-lg border ${hasErrors ? 'border-red-200 dark:border-red-800' : 'border-blue-200 dark:border-blue-800'}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full p-3 flex items-center justify-between text-left ${hasErrors ? 'bg-red-50 dark:bg-red-950/30' : 'bg-blue-50 dark:bg-blue-950/30'} rounded-t-lg ${!expanded ? 'rounded-b-lg' : ''}`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium ${hasErrors ? 'text-red-700 dark:text-red-300' : 'text-blue-700 dark:text-blue-300'}`}
          >
            {toolUses.length} tool call{toolUses.length !== 1 ? 's' : ''}: {summary}
          </span>
          {hasErrors && (
            <span className="text-xs px-1.5 py-0.5 bg-red-200 dark:bg-red-800 text-red-800 dark:text-red-200 rounded">
              error
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? '[-]' : '[+]'}</span>
      </button>
      {expanded && (
        <div className="p-2 space-y-2 bg-muted/20">
          {toolInfos.map((info) => (
            <ToolInfoRenderer key={info.id || `${info.type}-${info.name}`} info={info} />
          ))}
        </div>
      )}
    </div>
  );
}
