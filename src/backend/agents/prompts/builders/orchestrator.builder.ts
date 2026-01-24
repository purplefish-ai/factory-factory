/**
 * Orchestrator agent prompt builder
 *
 * Composes markdown prompt files with dynamic sections to build the orchestrator system prompt.
 *
 * NOTE: Orchestrator tools have been removed - all supervisor lifecycle management
 * is now handled by the reconciliation service. The orchestrator's role is now passive:
 * it monitors system health and can communicate via mail, but doesn't directly
 * manage supervisors. See docs/WORKFLOW.md and docs/RECONCILIATION_DESIGN.md.
 */

import { PromptBuilder } from '../../../prompts/index.js';
import {
  generateContextFooter,
  generateCurlIntro,
  generateToolsSection,
  getMailToolsForAgent,
} from '../sections/index.js';
import type { OrchestratorContext, ToolCategory } from '../types.js';

/**
 * Build the complete orchestrator system prompt
 */
export function buildOrchestratorPrompt(context: OrchestratorContext): string {
  // Build tools section - orchestrator now only has mail and agent tools
  // (supervisor management moved to reconciler service)
  const mailTools = getMailToolsForAgent('orchestrator');
  const toolCategories: ToolCategory[] = [{ name: 'Communication', tools: mailTools }];

  // Build prompt from markdown files + dynamic sections
  const builder = new PromptBuilder()
    // Core orchestrator identity (includes workflow, health checks, recovery)
    .addFile('orchestrator-role.md')
    // Shared behaviors (injected into all agents)
    .addFile('self-verification.md')
    .addFile('stuck-detection.md')
    // Dynamic sections
    .addRaw(generateCurlIntro())
    .addRaw(generateToolsSection(toolCategories));

  // Build and apply placeholders
  let prompt = builder.build();
  prompt = PromptBuilder.applyReplacements(prompt, {
    YOUR_AGENT_ID: context.agentId,
  });

  // Add context footer
  // NOTE: Orchestrator role is now passive - reconciler handles supervisor lifecycle
  const closingMessage = `You are the Orchestrator. The reconciliation service automatically manages supervisor lifecycle (creation, health monitoring, recovery). Your role is to observe system health and communicate with humans when intervention is needed.`;

  const footer = generateContextFooter(context, [], closingMessage);

  return prompt + footer;
}

// Re-export the context type for convenience
export type { OrchestratorContext } from '../types.js';
