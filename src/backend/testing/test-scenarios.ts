import { AgentType } from "@prisma/client";
import { runTestScenario, sendMcpTool } from "./mock-agent.js";

/**
 * Test Scenario 1: Mock worker sends mail to mock supervisor
 */
async function testMailCommunication(): Promise<void> {
  await runTestScenario("Mail Communication", async (createAgent) => {
    const workerId = await createAgent(AgentType.WORKER);
    const supervisorId = await createAgent(AgentType.SUPERVISOR);

    // Worker sends mail to supervisor
    const sendResult = await sendMcpTool(workerId, "mcp__mail__send", {
      toAgentId: supervisorId,
      subject: "Test Mail from Worker",
      body: "Hello supervisor, this is a test message!",
    });

    if (!sendResult.success) {
      throw new Error(`Failed to send mail: ${sendResult.error.message}`);
    }

    console.log("✓ Mail sent successfully");

    // Supervisor lists inbox
    const listResult = await sendMcpTool(
      supervisorId,
      "mcp__mail__list_inbox",
      {}
    );

    if (!listResult.success) {
      throw new Error(`Failed to list inbox: ${listResult.error.message}`);
    }

    console.log("✓ Supervisor inbox retrieved");

    // Verify mail is in inbox
    const inboxData = listResult.data as {
      mails: Array<{ id: string; subject: string }>;
    };
    if (inboxData.mails.length === 0) {
      throw new Error("Expected mail in inbox, but found none");
    }

    console.log("✓ Mail found in supervisor inbox");

    // Supervisor reads the mail
    const mailId = inboxData.mails[0].id;
    const readResult = await sendMcpTool(supervisorId, "mcp__mail__read", {
      mailId,
    });

    if (!readResult.success) {
      throw new Error(`Failed to read mail: ${readResult.error.message}`);
    }

    console.log("✓ Mail read successfully");

    // Supervisor replies
    const replyResult = await sendMcpTool(supervisorId, "mcp__mail__reply", {
      originalMailId: mailId,
      body: "Thanks for the message, worker!",
    });

    if (!replyResult.success) {
      throw new Error(`Failed to reply to mail: ${replyResult.error.message}`);
    }

    console.log("✓ Reply sent successfully");

    // Worker checks inbox for reply
    const workerInboxResult = await sendMcpTool(
      workerId,
      "mcp__mail__list_inbox",
      {}
    );

    if (!workerInboxResult.success) {
      throw new Error(
        `Failed to list worker inbox: ${workerInboxResult.error.message}`
      );
    }

    const workerInboxData = workerInboxResult.data as {
      mails: Array<{ subject: string }>;
    };
    if (workerInboxData.mails.length === 0) {
      throw new Error("Expected reply in worker inbox, but found none");
    }

    console.log("✓ Reply received in worker inbox");
  });
}

/**
 * Test Scenario 2: Permission denied scenarios
 */
async function testPermissions(): Promise<void> {
  await runTestScenario("Permission System", async (createAgent) => {
    const workerId = await createAgent(AgentType.WORKER);

    // Worker tries to use a non-existent orchestrator tool
    const result = await sendMcpTool(
      workerId,
      "mcp__orchestrator__create_task",
      {}
    );

    if (result.success) {
      throw new Error("Expected permission denial, but tool succeeded");
    }

    if (result.error.code !== "PERMISSION_DENIED") {
      throw new Error(
        `Expected PERMISSION_DENIED error, got ${result.error.code}`
      );
    }

    console.log("✓ Permission correctly denied for worker using orchestrator tool");
  });
}

/**
 * Test Scenario 3: Agent introspection
 */
async function testAgentIntrospection(): Promise<void> {
  await runTestScenario("Agent Introspection", async (createAgent) => {
    const workerId = await createAgent(AgentType.WORKER);

    // Worker gets own status
    const statusResult = await sendMcpTool(
      workerId,
      "mcp__agent__get_status",
      {}
    );

    if (!statusResult.success) {
      throw new Error(
        `Failed to get status: ${statusResult.error.message}`
      );
    }

    const status = statusResult.data as { type: string; state: string };
    if (status.type !== AgentType.WORKER) {
      throw new Error(`Expected type WORKER, got ${status.type}`);
    }

    console.log("✓ Agent status retrieved successfully");

    // Worker tries to get task (should fail - no task assigned)
    const taskResult = await sendMcpTool(
      workerId,
      "mcp__agent__get_task",
      {}
    );

    if (taskResult.success) {
      throw new Error("Expected task retrieval to fail (no task assigned)");
    }

    if (taskResult.error.code !== "INVALID_AGENT_STATE") {
      throw new Error(
        `Expected INVALID_AGENT_STATE error, got ${taskResult.error.code}`
      );
    }

    console.log("✓ Task retrieval correctly failed (no task assigned)");
  });
}

/**
 * Test Scenario 4: Manual decision logging
 */
async function testDecisionLogging(): Promise<void> {
  await runTestScenario("Decision Logging", async (createAgent) => {
    const workerId = await createAgent(AgentType.WORKER);

    // Log a manual decision
    const logResult = await sendMcpTool(
      workerId,
      "mcp__system__log_decision",
      {
        title: "Test Decision",
        body: "This is a test decision logged by the worker",
      }
    );

    if (!logResult.success) {
      throw new Error(`Failed to log decision: ${logResult.error.message}`);
    }

    console.log("✓ Decision logged successfully");
  });
}

/**
 * Test Scenario 5: Mail to human
 */
async function testMailToHuman(): Promise<void> {
  await runTestScenario("Mail to Human", async (createAgent) => {
    const workerId = await createAgent(AgentType.WORKER);

    // Worker sends mail to human
    const sendResult = await sendMcpTool(workerId, "mcp__mail__send", {
      toHuman: true,
      subject: "Help Needed",
      body: "I need human assistance with this task",
    });

    if (!sendResult.success) {
      throw new Error(`Failed to send mail: ${sendResult.error.message}`);
    }

    console.log("✓ Mail to human sent successfully");
  });
}

/**
 * Run all test scenarios
 */
export async function runAllTests(): Promise<void> {
  console.log("\n🧪 Starting MCP Phase 1 Test Suite\n");

  try {
    await testMailCommunication();
    await testPermissions();
    await testAgentIntrospection();
    await testDecisionLogging();
    await testMailToHuman();

    console.log("\n✅ All test scenarios passed!\n");
  } catch (error) {
    console.error("\n❌ Test suite failed:", error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
