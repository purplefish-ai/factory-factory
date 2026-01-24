/**
 * Tool documentation section generator
 *
 * Generates curl command examples for backend tools.
 */

import type { ToolCategory, ToolDefinition } from '../types.js';

export interface ToolDocOptions {
  agentIdPlaceholder?: string;
  backendUrl?: string;
}

/**
 * Generate documentation for a single tool with curl example
 */
export function generateToolDoc(tool: ToolDefinition, options?: ToolDocOptions): string {
  const placeholder = options?.agentIdPlaceholder ?? 'YOUR_AGENT_ID';
  const url = options?.backendUrl ?? 'http://localhost:3001';

  // Format input JSON with proper indentation
  const inputJson = tool.inputExample
    ? JSON.stringify(tool.inputExample, null, 2)
        .split('\n')
        .map((line, i) => (i === 0 ? line : `      ${line}`))
        .join('\n')
    : '{}';

  // Build the doc
  let doc = `**${tool.name}** - ${tool.description}`;

  // Add any comments before the curl command
  if (tool.inputComments && tool.inputComments.length > 0) {
    doc += '\n```bash';
    for (const comment of tool.inputComments) {
      doc += `\n# ${comment}`;
    }
    doc += '\n```';
  }

  doc += `
\`\`\`bash
curl -X POST ${url}/mcp/execute \\
  -H "Content-Type: application/json" \\
  -d '{
    "agentId": "${placeholder}",
    "toolName": "${tool.name}",
    "input": ${inputJson}
  }'
\`\`\``;

  return doc;
}

/**
 * Generate a tools section with multiple tools grouped by category
 */
export function generateToolsSection(categories: ToolCategory[], options?: ToolDocOptions): string {
  const sections = categories.map((category) => {
    const toolDocs = category.tools.map((tool) => generateToolDoc(tool, options)).join('\n\n');

    return `### ${category.name}\n\n${toolDocs}`;
  });

  return `## Available Tools\n\n${sections.join('\n\n')}`;
}
