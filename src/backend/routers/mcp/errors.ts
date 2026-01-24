import type { Agent } from '@prisma-gen/client';
import { mailAccessor } from '../../resource_accessors/index.js';

/**
 * Tools that are critical for agent operation
 * Failures of these tools should be escalated immediately
 */
export const CRITICAL_TOOLS = [
  'mcp__mail__send',
  'mcp__agent__get_task',
  'mcp__agent__get_top_level_task',
  'mcp__task__update_status',
  'mcp__supervisor__update_status',
];

/**
 * Check if an error is transient (retryable)
 */
export function isTransientError(error: Error): boolean {
  const transientPatterns = [
    /timeout/i,
    /connection/i,
    /network/i,
    /temporary/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
  ];

  return transientPatterns.some((pattern) => pattern.test(error.message));
}

/**
 * Escalate a tool failure to the agent's supervisor
 */
export async function escalateToolFailure(
  agent: Agent,
  toolName: string,
  error: Error
): Promise<void> {
  // Determine recipient based on agent type
  const recipientAgentId: string | null = null;

  if (agent.type === 'WORKER') {
    // Workers escalate to their epic's orchestrator
    // This would require fetching the task -> epic -> orchestrator
    // For now, we'll send to human for simplicity
  } else if (agent.type === 'ORCHESTRATOR') {
    // Orchestrators escalate to supervisor
    // This would require finding the supervisor agent
  }

  // Create escalation mail
  const subject = `Tool Failure: ${toolName}`;
  const body = `
Agent ${agent.id} (${agent.type}) encountered a failure using tool '${toolName}'.

Error: ${error.message}

Stack trace:
${error.stack || 'N/A'}

Agent state: ${agent.state}
Last active: ${agent.lastActiveAt}
  `.trim();

  // Send to human if no specific recipient found
  await mailAccessor.create({
    fromAgentId: agent.id,
    toAgentId: recipientAgentId ?? undefined,
    isForHuman: recipientAgentId === null,
    subject,
    body,
  });
}

/**
 * Escalate a critical tool failure immediately
 */
export async function escalateCriticalError(
  agent: Agent,
  toolName: string,
  error: Error
): Promise<void> {
  const subject = `CRITICAL: Tool Failure - ${toolName}`;
  const body = `
⚠️ CRITICAL TOOL FAILURE ⚠️

Agent ${agent.id} (${agent.type}) encountered a critical failure using tool '${toolName}'.

Error: ${error.message}

Stack trace:
${error.stack || 'N/A'}

Agent state: ${agent.state}
Current task: ${agent.currentTaskId || 'N/A'}

This tool is marked as critical and requires immediate attention.
  `.trim();

  // Always send critical errors to human
  await mailAccessor.create({
    fromAgentId: agent.id,
    toAgentId: undefined,
    isForHuman: true,
    subject,
    body,
  });
}
