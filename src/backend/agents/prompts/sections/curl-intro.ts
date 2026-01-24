/**
 * Curl pattern intro section generator
 *
 * Generates the standard curl command documentation that appears in all agent prompts.
 */

export interface CurlIntroOptions {
  agentIdPlaceholder?: string;
  backendUrl?: string;
}

/**
 * Generate the curl intro section explaining how to call backend tools
 */
export function generateCurlIntro(options?: CurlIntroOptions): string {
  const placeholder = options?.agentIdPlaceholder ?? 'YOUR_AGENT_ID';
  const url = options?.backendUrl ?? 'http://localhost:3001';

  return `## How to Call Backend Tools

You interact with the FactoryFactory backend via HTTP API calls using curl. All tool calls follow this pattern:

\`\`\`bash
curl -X POST ${url}/mcp/execute \\
  -H "Content-Type: application/json" \\
  -d '{
    "agentId": "${placeholder}",
    "toolName": "TOOL_NAME",
    "input": { ... }
  }'
\`\`\``;
}
