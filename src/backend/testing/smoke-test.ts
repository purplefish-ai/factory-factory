#!/usr/bin/env tsx

/**
 * Phase 1 Smoke Test
 * Verifies all core MCP infrastructure is working
 */

import { AgentType } from '@prisma-gen/client';
import { getRegisteredTools } from '../routers/mcp/index.js';
import { checkToolPermissions } from '../routers/mcp/permissions.js';
import { cleanupMockAgent, createMockAgent, sendMcpTool } from './mock-agent.js';

console.log('🧪 Phase 1 Smoke Test\n');

// Test 1: Tool Registry
console.log('1. Checking MCP Tool Registry...');
const tools = getRegisteredTools();
const expectedTools = [
  'mcp__mail__list_inbox',
  'mcp__mail__read',
  'mcp__mail__send',
  'mcp__mail__reply',
  'mcp__agent__get_status',
  'mcp__agent__get_task',
  'mcp__agent__get_epic',
  'mcp__system__log_decision',
];

for (const toolName of expectedTools) {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`   ❌ Tool '${toolName}' not registered`);
    process.exit(1);
  }
}
console.log(`   ✅ All ${expectedTools.length} tools registered\n`);

// Test 2: Permission System
console.log('2. Checking Permission System...');
const workerPermission = checkToolPermissions(AgentType.WORKER, 'mcp__mail__send');
if (!workerPermission.allowed) {
  console.error('   ❌ Worker should be able to send mail');
  process.exit(1);
}

const workerOrchestratorPermission = checkToolPermissions(
  AgentType.WORKER,
  'mcp__orchestrator__create_task'
);
if (workerOrchestratorPermission.allowed) {
  console.error('   ❌ Worker should NOT be able to use orchestrator tools');
  process.exit(1);
}

const supervisorPermission = checkToolPermissions(
  AgentType.SUPERVISOR,
  'mcp__orchestrator__create_task'
);
if (!supervisorPermission.allowed) {
  console.error('   ❌ Supervisor should be able to use all tools');
  process.exit(1);
}
console.log('   ✅ Permission system working correctly\n');

// Test 3: Mail System
console.log('3. Testing Mail System...');
const worker1 = await createMockAgent(AgentType.WORKER);
const worker2 = await createMockAgent(AgentType.WORKER);

const sendResult = await sendMcpTool(worker1, 'mcp__mail__send', {
  toAgentId: worker2,
  subject: 'Smoke Test',
  body: 'Testing mail system',
});

if (!sendResult.success) {
  console.error('   ❌ Failed to send mail:', sendResult.error);
  await cleanupMockAgent(worker1);
  await cleanupMockAgent(worker2);
  process.exit(1);
}

const listResult = await sendMcpTool(worker2, 'mcp__mail__list_inbox', {});
if (!listResult.success) {
  console.error('   ❌ Failed to list inbox:', listResult.error);
  await cleanupMockAgent(worker1);
  await cleanupMockAgent(worker2);
  process.exit(1);
}

const inboxData = listResult.data as { mails: unknown[] };
if (inboxData.mails.length === 0) {
  console.error('   ❌ Expected mail in inbox but found none');
  await cleanupMockAgent(worker1);
  await cleanupMockAgent(worker2);
  process.exit(1);
}

await cleanupMockAgent(worker1);
await cleanupMockAgent(worker2);
console.log('   ✅ Mail system working\n');

// Test 4: Agent Introspection
console.log('4. Testing Agent Introspection...');
const worker3 = await createMockAgent(AgentType.WORKER);

const statusResult = await sendMcpTool(worker3, 'mcp__agent__get_status', {});
if (!statusResult.success) {
  console.error('   ❌ Failed to get agent status:', statusResult.error);
  await cleanupMockAgent(worker3);
  process.exit(1);
}

const statusData = statusResult.data as { type: AgentType };
if (statusData.type !== AgentType.WORKER) {
  console.error('   ❌ Expected agent type WORKER but got:', statusData.type);
  await cleanupMockAgent(worker3);
  process.exit(1);
}

await cleanupMockAgent(worker3);
console.log('   ✅ Agent introspection working\n');

// Test 5: Decision Logging
console.log('5. Testing Decision Logging...');
const worker4 = await createMockAgent(AgentType.WORKER);

const logResult = await sendMcpTool(worker4, 'mcp__system__log_decision', {
  title: 'Smoke Test Decision',
  body: 'Testing decision logging',
});

if (!logResult.success) {
  console.error('   ❌ Failed to log decision:', logResult.error);
  await cleanupMockAgent(worker4);
  process.exit(1);
}

await cleanupMockAgent(worker4);
console.log('   ✅ Decision logging working\n');

console.log('✅ All smoke tests passed!\n');
console.log('Phase 1 implementation is complete and functional.');
