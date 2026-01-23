import { AgentState, AgentType, EpicState, TaskState } from '@prisma/client';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
  mailAccessor,
  taskAccessor,
} from './src/backend/resource_accessors';

async function testPhase0() {
  console.log('🧪 Testing Phase 0 Implementation...\n');

  try {
    // Test Epic Accessor
    console.log('1. Testing Epic Accessor...');
    const epic = await epicAccessor.create({
      linearIssueId: 'TEST-123',
      linearIssueUrl: 'https://linear.app/test/issue/TEST-123',
      title: 'Test Epic for Phase 0',
      description: 'This is a test epic',
      state: EpicState.PLANNING,
    });
    console.log('   ✅ Created epic:', epic.id);

    // Test Task Accessor
    console.log('2. Testing Task Accessor...');
    const task = await taskAccessor.create({
      epicId: epic.id,
      title: 'Test Task',
      description: 'This is a test task',
      state: TaskState.PENDING,
    });
    console.log('   ✅ Created task:', task.id);

    // Test Agent Accessor
    console.log('3. Testing Agent Accessor...');
    const agent = await agentAccessor.create({
      type: AgentType.WORKER,
      state: AgentState.IDLE,
    });
    console.log('   ✅ Created agent:', agent.id);

    // Test Mail Accessor
    console.log('4. Testing Mail Accessor...');
    const mail = await mailAccessor.create({
      fromAgentId: agent.id,
      isForHuman: true,
      subject: 'Test Mail',
      body: 'This is a test mail message',
    });
    console.log('   ✅ Created mail:', mail.id);

    // Test Decision Log Accessor
    console.log('5. Testing Decision Log Accessor...');
    const log = await decisionLogAccessor.create({
      agentId: agent.id,
      decision: 'Test decision',
      reasoning: 'Testing the decision log',
      context: 'Phase 0 smoke test',
    });
    console.log('   ✅ Created decision log:', log.id);

    // Test Read Operations
    console.log('\n6. Testing Read Operations...');
    const fetchedEpic = await epicAccessor.findById(epic.id);
    console.log('   ✅ Found epic by ID:', fetchedEpic?.title);

    const tasksByEpic = await taskAccessor.findByEpicId(epic.id);
    console.log('   ✅ Found', tasksByEpic.length, 'task(s) for epic');

    const humanMail = await mailAccessor.listHumanInbox();
    console.log('   ✅ Found', humanMail.length, 'mail(s) in human inbox');

    const agentLogs = await decisionLogAccessor.findByAgentId(agent.id);
    console.log('   ✅ Found', agentLogs.length, 'decision log(s) for agent');

    // Test Update Operations
    console.log('\n7. Testing Update Operations...');
    await epicAccessor.update(epic.id, { state: EpicState.IN_PROGRESS });
    console.log('   ✅ Updated epic state to IN_PROGRESS');

    await taskAccessor.update(task.id, { state: TaskState.ASSIGNED, assignedAgentId: agent.id });
    console.log('   ✅ Assigned task to agent');

    await mailAccessor.markAsRead(mail.id);
    console.log('   ✅ Marked mail as read');

    // Test List Operations
    console.log('\n8. Testing List Operations...');
    const epics = await epicAccessor.list({ state: EpicState.IN_PROGRESS });
    console.log('   ✅ Listed', epics.length, 'epic(s) in IN_PROGRESS state');

    const tasks = await taskAccessor.list({ assignedAgentId: agent.id });
    console.log('   ✅ Listed', tasks.length, 'task(s) assigned to agent');

    const agents = await agentAccessor.findByType(AgentType.WORKER);
    console.log('   ✅ Listed', agents.length, 'WORKER agent(s)');

    // Cleanup
    console.log('\n9. Cleaning up test data...');
    await decisionLogAccessor.delete(log.id);
    await mailAccessor.delete(mail.id);
    await taskAccessor.delete(task.id);
    await agentAccessor.delete(agent.id);
    await epicAccessor.delete(epic.id);
    console.log('   ✅ Cleanup complete');

    console.log('\n✨ All Phase 0 database tests passed!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testPhase0();
