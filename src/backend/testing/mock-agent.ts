import type { AgentType } from "@prisma/client";
import { agentAccessor } from "../resource_accessors/index.js";
import { executeMcpTool } from "../routers/mcp/index.js";
import type { McpToolResponse } from "../routers/mcp/types.js";

/**
 * Create a mock agent for testing
 */
export async function createMockAgent(type: AgentType): Promise<string> {
  const agent = await agentAccessor.create({
    type,
  });

  console.log(`Created mock agent: ${agent.id} (${agent.type})`);
  return agent.id;
}

/**
 * Send an MCP tool call as a mock agent
 */
export async function sendMcpTool<TInput = unknown, TOutput = unknown>(
  agentId: string,
  toolName: string,
  input: TInput
): Promise<McpToolResponse<TOutput>> {
  console.log(
    `Mock agent ${agentId} calling tool '${toolName}' with input:`,
    input
  );

  const result = await executeMcpTool<TInput, TOutput>(
    agentId,
    toolName,
    input
  );

  console.log(`Tool '${toolName}' result:`, result);
  return result;
}

/**
 * Get MCP tool response (alias for sendMcpTool)
 */
export const getMcpToolResponse = sendMcpTool;

/**
 * Cleanup mock agent and related data
 */
export async function cleanupMockAgent(agentId: string): Promise<void> {
  try {
    await agentAccessor.delete(agentId);
    console.log(`Cleaned up mock agent: ${agentId}`);
  } catch (error) {
    console.error(`Error cleaning up mock agent ${agentId}:`, error);
  }
}

/**
 * Run a test scenario with automatic cleanup
 */
export async function runTestScenario(
  name: string,
  scenario: (createAgent: typeof createMockAgent) => Promise<void>
): Promise<void> {
  console.log(`\n========================================`);
  console.log(`Running test scenario: ${name}`);
  console.log(`========================================\n`);

  const createdAgents: string[] = [];

  const createAgentWithTracking = async (type: AgentType): Promise<string> => {
    const agentId = await createMockAgent(type);
    createdAgents.push(agentId);
    return agentId;
  };

  try {
    await scenario(createAgentWithTracking);
    console.log(`\n✅ Test scenario '${name}' completed successfully\n`);
  } catch (error) {
    console.error(`\n❌ Test scenario '${name}' failed:`, error);
    throw error;
  } finally {
    // Cleanup all created agents
    for (const agentId of createdAgents) {
      await cleanupMockAgent(agentId);
    }
  }
}
