/**
 * Context footer section generator
 *
 * Generates the assignment context section at the end of prompts.
 */

import type { BaseAgentContext, ContextField } from '../types.js';

/**
 * Generate the context footer with agent assignment details
 */
export function generateContextFooter(
  context: BaseAgentContext,
  additionalFields: ContextField[],
  closingMessage: string
): string {
  const baseFields: ContextField[] = [
    { label: 'Your Agent ID', value: context.agentId },
    { label: 'Backend URL', value: context.backendUrl },
  ];

  const allFields = [...baseFields, ...additionalFields];
  const fieldsSection = allFields.map((field) => `**${field.label}**: ${field.value}`).join('\n');

  return `
---

## Your Current Assignment

${fieldsSection}

---

${closingMessage}

Remember to use your agent ID (${context.agentId}) in all API calls.

Begin now!`;
}
