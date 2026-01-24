/**
 * Mail tools definitions
 *
 * Shared mail tool definitions used across agent types.
 */

import type { AgentType, ToolDefinition } from '../types.js';

/**
 * Mail tool definitions
 */
const MAIL_TOOLS: Record<string, ToolDefinition> = {
  listInbox: {
    name: 'mcp__mail__list_inbox',
    description: 'Check for messages',
    inputExample: {},
  },
  read: {
    name: 'mcp__mail__read',
    description: 'Read a specific message',
    inputExample: { mailId: 'mail-id-here' },
  },
  send: {
    name: 'mcp__mail__send',
    description: 'Send a message to a worker or human',
    inputExample: {
      toAgentId: 'worker-agent-id',
      subject: 'Message subject',
      body: 'Message content',
    },
  },
  sendToSupervisor: {
    name: 'mcp__mail__send',
    description: 'Send a message to your supervisor',
    inputExample: {
      toAgentId: 'SUPERVISOR_AGENT_ID',
      subject: 'Code Ready for Review',
      body: 'I have completed the task. Code is committed and ready for your review.',
    },
  },
  sendToHuman: {
    name: 'mcp__mail__send',
    description: 'Send a message to a supervisor or human',
    inputExample: {
      toAgentId: 'agent-id-or-null-for-human',
      isForHuman: true,
      subject: 'Message subject',
      body: 'Message content',
    },
  },
};

/**
 * Get mail tools appropriate for an agent type
 */
export function getMailToolsForAgent(agentType: AgentType): ToolDefinition[] {
  switch (agentType) {
    case 'orchestrator':
      return [MAIL_TOOLS.listInbox, MAIL_TOOLS.sendToHuman];
    case 'supervisor':
      return [MAIL_TOOLS.listInbox, MAIL_TOOLS.read, MAIL_TOOLS.send];
    case 'worker':
      return [MAIL_TOOLS.sendToSupervisor, MAIL_TOOLS.listInbox];
  }
}
