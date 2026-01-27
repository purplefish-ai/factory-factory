# Generator-Based Agent Control Pattern

## 1. Executive Summary

This document proposes adopting a generator-based control pattern for agent workflows in factory-factory, inspired by Codebuff's approach. This pattern allows mixing **deterministic imperative code** with **non-deterministic AI decisions**, giving precise control over agent behavior while preserving flexibility.

## 2. The Problem with Pure Prompt-Based Agents

Currently, factory-factory agents are purely prompt-driven:

```typescript
// Current approach
const client = new ClaudeClient(options);
await client.sendMessage("Implement user authentication");
// Hope Claude does the right thing...
```

This has several limitations:

| Issue | Impact |
|-------|--------|
| **Unpredictable flow** | Can't guarantee specific steps happen |
| **No error handling** | AI must interpret and handle errors |
| **Difficult composition** | Hard to coordinate multiple agents |
| **Testing challenges** | Can't unit test workflow logic |
| **Retry complexity** | No clean way to retry specific steps |

## 3. The Generator Pattern

### 3.1 Core Concept

JavaScript generators (`function*`) yield control back to a runtime, which can then resume the generator with new data. This creates a natural "pause and resume" pattern:

```typescript
function* simpleExample() {
  console.log("Step 1");
  const result = yield "waiting for input";
  console.log("Step 2, got:", result);
  return "done";
}

const gen = simpleExample();
gen.next();           // logs "Step 1", returns { value: "waiting for input", done: false }
gen.next("hello");    // logs "Step 2, got: hello", returns { value: "done", done: true }
```

### 3.2 Applied to Agent Control

```typescript
interface AgentWorkflow {
  handleSteps: (context: WorkflowContext) => AsyncGenerator<WorkflowStep, WorkflowResult>;
}

type WorkflowStep =
  | { type: 'tool'; name: string; input: unknown }      // Execute a tool
  | { type: 'spawn'; agentType: AgentType; task: string } // Spawn sub-agent
  | { type: 'ai_turn' }                                   // Let Claude take a turn
  | { type: 'parallel'; steps: WorkflowStep[] };          // Run steps in parallel

interface WorkflowResult {
  success: boolean;
  output: unknown;
}
```

## 4. Detailed Design

### 4.1 Workflow Definition

```typescript
// src/backend/agents/workflows/supervisor-workflow.ts
import { AgentWorkflow, WorkflowContext, WorkflowStep } from '../types';

export const supervisorWorkflow: AgentWorkflow = {
  async *handleSteps(ctx: WorkflowContext): AsyncGenerator<WorkflowStep, WorkflowResult> {
    const { task, workspace } = ctx;

    // STEP 1: Always analyze the task first (deterministic)
    yield {
      type: 'tool',
      name: 'glob',
      input: { pattern: '**/*.{ts,tsx}' }
    };

    // STEP 2: Spawn planner to decompose the task
    const plan = yield {
      type: 'spawn',
      agentType: 'planner',
      task: `Analyze and decompose: ${task}`
    };

    // STEP 3: Validate plan has subtasks (imperative check)
    if (!plan.subtasks || plan.subtasks.length === 0) {
      // Let AI figure out what to do
      const recovery = yield { type: 'ai_turn' };
      if (!recovery.subtasks) {
        return { success: false, output: 'Failed to decompose task' };
      }
      plan.subtasks = recovery.subtasks;
    }

    // STEP 4: Spawn workers in parallel (deterministic orchestration)
    const workerResults = yield {
      type: 'parallel',
      steps: plan.subtasks.map(subtask => ({
        type: 'spawn',
        agentType: 'worker',
        task: subtask.description,
      })),
    };

    // STEP 5: Always run reviewer (guaranteed step)
    const review = yield {
      type: 'spawn',
      agentType: 'reviewer',
      task: 'Review all changes made by workers',
    };

    // STEP 6: Conditional fixer spawning (imperative decision)
    if (review.issues && review.issues.length > 0) {
      yield {
        type: 'spawn',
        agentType: 'fixer',
        task: `Fix issues: ${JSON.stringify(review.issues)}`,
      };
    }

    // STEP 7: Let AI compose final summary
    const summary = yield { type: 'ai_turn' };

    return {
      success: true,
      output: summary
    };
  },
};
```

### 4.2 Workflow Runtime

```typescript
// src/backend/agents/workflow-runtime.ts
import { ClaudeClient } from '../claude';
import { AgentWorkflow, WorkflowStep, WorkflowResult } from './types';

export class WorkflowRuntime {
  private client: ClaudeClient;
  private agentController: AgentController;

  constructor(
    private workspace: Workspace,
    private agentType: AgentType,
  ) {}

  async execute(workflow: AgentWorkflow, task: string): Promise<WorkflowResult> {
    const context: WorkflowContext = {
      task,
      workspace: this.workspace,
      tools: this.getToolsForAgent(this.agentType),
    };

    const generator = workflow.handleSteps(context);
    let lastResult: unknown = undefined;

    while (true) {
      const { value: step, done } = await generator.next(lastResult);

      if (done) {
        return step as WorkflowResult;
      }

      lastResult = await this.executeStep(step);
    }
  }

  private async executeStep(step: WorkflowStep): Promise<unknown> {
    switch (step.type) {
      case 'tool':
        return this.executeTool(step.name, step.input);

      case 'spawn':
        return this.spawnAgent(step.agentType, step.task);

      case 'ai_turn':
        return this.letAiRespond();

      case 'parallel':
        return Promise.all(step.steps.map(s => this.executeStep(s)));

      default:
        throw new Error(`Unknown step type: ${(step as any).type}`);
    }
  }

  private async executeTool(name: string, input: unknown): Promise<unknown> {
    // Execute via MCP or direct tool call
    return this.client.executeTool(name, input);
  }

  private async spawnAgent(agentType: AgentType, task: string): Promise<unknown> {
    const childSession = await this.agentController.spawn({
      workspaceId: this.workspace.id,
      agentType,
      task,
    });
    return this.agentController.waitForCompletion(childSession.id);
  }

  private async letAiRespond(): Promise<unknown> {
    // Send accumulated context to Claude and get response
    const response = await this.client.sendMessage('Continue with the workflow.');
    return this.parseAiResponse(response);
  }
}
```

### 4.3 Agent Definition with Workflow

```typescript
// src/backend/agents/definitions/supervisor.ts
import { AgentDefinition } from '../types';
import { supervisorWorkflow } from '../workflows/supervisor-workflow';

export const supervisorAgent: AgentDefinition = {
  type: 'supervisor',
  model: 'sonnet',

  // Static configuration
  spawnableAgents: ['worker', 'planner', 'reviewer'],
  toolPermissions: {
    allowed: ['Read', 'Glob', 'Grep', 'mcp__git__*'],
    disallowed: ['Write', 'Edit', 'Bash'],
  },

  // System prompt for AI turns
  systemPrompt: `You are a Supervisor agent responsible for coordinating work.
When asked to continue, provide structured JSON responses.
Focus on task decomposition and quality review.`,

  // Generator-based workflow
  workflow: supervisorWorkflow,
};
```

## 5. Workflow Patterns

### 5.1 Sequential Steps

```typescript
async *handleSteps(ctx) {
  const step1 = yield { type: 'tool', name: 'read_file', input: { path: 'package.json' } };
  const step2 = yield { type: 'tool', name: 'read_file', input: { path: 'tsconfig.json' } };
  // step2 only runs after step1 completes
}
```

### 5.2 Parallel Execution

```typescript
async *handleSteps(ctx) {
  const results = yield {
    type: 'parallel',
    steps: [
      { type: 'spawn', agentType: 'worker', task: 'Task A' },
      { type: 'spawn', agentType: 'worker', task: 'Task B' },
      { type: 'spawn', agentType: 'worker', task: 'Task C' },
    ],
  };
  // All three workers run concurrently
}
```

### 5.3 Conditional Branching

```typescript
async *handleSteps(ctx) {
  const analysis = yield { type: 'spawn', agentType: 'planner', task: ctx.task };

  if (analysis.complexity === 'high') {
    // Complex path: use thinking-heavy model
    yield { type: 'spawn', agentType: 'thinker', task: 'Deep analysis needed' };
  } else {
    // Simple path: go straight to implementation
    yield { type: 'spawn', agentType: 'worker', task: analysis.simplifiedTask };
  }
}
```

### 5.4 Retry with Backoff

```typescript
async *handleSteps(ctx) {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = yield { type: 'spawn', agentType: 'worker', task: ctx.task };
      if (result.success) {
        return { success: true, output: result };
      }
      lastError = new Error(result.error);
    } catch (error) {
      lastError = error;
    }

    // Exponential backoff via AI analysis
    if (attempt < maxRetries) {
      yield {
        type: 'ai_turn',
        context: `Attempt ${attempt} failed: ${lastError.message}. Analyze and suggest fix.`
      };
    }
  }

  return { success: false, output: `Failed after ${maxRetries} attempts: ${lastError}` };
}
```

### 5.5 Loop Until Condition

```typescript
async *handleSteps(ctx) {
  let testsPass = false;
  let iterations = 0;
  const maxIterations = 5;

  while (!testsPass && iterations < maxIterations) {
    iterations++;

    // Run implementation
    yield { type: 'spawn', agentType: 'worker', task: ctx.task };

    // Run tests
    const testResult = yield { type: 'tool', name: 'bash', input: { command: 'npm test' } };
    testsPass = testResult.exitCode === 0;

    if (!testsPass) {
      // Spawn fixer to address test failures
      yield {
        type: 'spawn',
        agentType: 'fixer',
        task: `Fix test failures: ${testResult.stderr}`
      };
    }
  }

  return { success: testsPass, output: { iterations, testsPass } };
}
```

### 5.6 Fan-Out / Fan-In

```typescript
async *handleSteps(ctx) {
  // Fan out: spawn multiple reviewers with different focuses
  const reviews = yield {
    type: 'parallel',
    steps: [
      { type: 'spawn', agentType: 'reviewer', task: 'Review for correctness' },
      { type: 'spawn', agentType: 'reviewer', task: 'Review for security' },
      { type: 'spawn', agentType: 'reviewer', task: 'Review for performance' },
    ],
  };

  // Fan in: aggregate results
  const allIssues = reviews.flatMap(r => r.issues || []);
  const criticalIssues = allIssues.filter(i => i.severity === 'critical');

  if (criticalIssues.length > 0) {
    yield { type: 'spawn', agentType: 'fixer', task: `Fix critical: ${JSON.stringify(criticalIssues)}` };
  }

  return { success: criticalIssues.length === 0, output: { reviews, allIssues } };
}
```

## 6. Integration with Existing System

### 6.1 ClaudeClient Modifications

Add methods to support workflow execution:

```typescript
// src/backend/claude/index.ts
export class ClaudeClient {
  // Existing methods...

  /**
   * Execute a tool and return the result.
   * Used by workflow runtime for deterministic tool calls.
   */
  async executeTool(name: string, input: unknown): Promise<ToolResult> {
    // Send tool_result message and wait for completion
  }

  /**
   * Let Claude take a turn with optional context injection.
   * Used by workflow runtime for AI decision points.
   */
  async aiTurn(context?: string): Promise<AiTurnResult> {
    const message = context
      ? `Continue. Context: ${context}`
      : 'Continue with the next step.';
    return this.sendMessage(message);
  }
}
```

### 6.2 AgentProcessAdapter Modifications

```typescript
// src/backend/agents/process-adapter.ts
export class AgentProcessAdapter {
  private workflows: Map<AgentType, AgentWorkflow>;
  private runtime: WorkflowRuntime;

  async startAgent(options: StartAgentOptions): Promise<void> {
    const workflow = this.workflows.get(options.agentType);

    if (workflow) {
      // Use generator-based execution
      await this.runtime.execute(workflow, options.task);
    } else {
      // Fall back to pure prompt-based execution
      await this.startPurePromptAgent(options);
    }
  }
}
```

### 6.3 Database Tracking

Track workflow state for resumption:

```prisma
model AgentSession {
  // Existing fields...

  // Workflow tracking
  workflowType      String?    // Name of the workflow being executed
  workflowState     Json?      // Serialized generator state for resumption
  currentStepIndex  Int        @default(0)
  stepHistory       Json?      // Record of completed steps and results
}
```

## 7. Comparison: Before and After

### Before (Pure Prompt)

```typescript
// Entire behavior determined by prompt
const prompt = `
You are a supervisor. Your task: ${task}

1. First, analyze the codebase
2. Then decompose into subtasks
3. Create workers for each subtask
4. Wait for completion
5. Review the results
6. Fix any issues
7. Create a PR

Please proceed.
`;

await client.sendMessage(prompt);
// Hope it follows the steps...
// Can't guarantee any specific behavior
// Hard to handle failures
// Can't run steps in parallel
```

### After (Generator-Based)

```typescript
async *handleSteps(ctx) {
  // GUARANTEED: Always analyze first
  yield { type: 'tool', name: 'glob', input: { pattern: '**/*.ts' } };

  // GUARANTEED: Always get a plan
  const plan = yield { type: 'spawn', agentType: 'planner', task: ctx.task };

  // GUARANTEED: Parallel worker execution
  const results = yield {
    type: 'parallel',
    steps: plan.subtasks.map(t => ({ type: 'spawn', agentType: 'worker', task: t })),
  };

  // GUARANTEED: Always review
  const review = yield { type: 'spawn', agentType: 'reviewer', task: 'Review changes' };

  // CONDITIONAL: Fix only if needed (imperative logic)
  if (review.issues.length > 0) {
    yield { type: 'spawn', agentType: 'fixer', task: `Fix: ${review.issues}` };
  }

  // AI gets final say on summary
  return yield { type: 'ai_turn' };
}
```

## 8. Benefits

| Benefit | Description |
|---------|-------------|
| **Guaranteed Steps** | Critical steps always execute in order |
| **Error Handling** | Try/catch around specific steps |
| **Testability** | Unit test workflow logic without AI |
| **Parallelization** | Explicit control over concurrent execution |
| **Resumption** | Can serialize and resume generator state |
| **Observability** | Clear step-by-step execution trace |
| **Composition** | Workflows can yield to other workflows |
| **Type Safety** | TypeScript checks step structure |

## 9. Implementation Plan

### Phase 1: Core Infrastructure
- Define `WorkflowStep` and `WorkflowResult` types
- Implement `WorkflowRuntime` class
- Add workflow support to `AgentProcessAdapter`

### Phase 2: Basic Workflows
- Implement `supervisorWorkflow` with sequential steps
- Implement `workerWorkflow` with tool execution
- Add parallel execution support

### Phase 3: Advanced Patterns
- Implement retry logic with exponential backoff
- Add loop constructs for iterative refinement
- Implement fan-out/fan-in patterns

### Phase 4: State Persistence
- Serialize generator state to database
- Implement workflow resumption after crash
- Add step history tracking

### Phase 5: Observability
- Add workflow execution tracing
- Implement step-level metrics
- Create visualization for workflow progress

## 10. Example: Complete Worker Workflow

```typescript
// src/backend/agents/workflows/worker-workflow.ts
export const workerWorkflow: AgentWorkflow = {
  async *handleSteps(ctx: WorkflowContext): AsyncGenerator<WorkflowStep, WorkflowResult> {
    const { task, workspace } = ctx;

    // Phase 1: Orientation (deterministic)
    const files = yield { type: 'tool', name: 'glob', input: { pattern: '**/*.{ts,tsx}' } };

    // Phase 2: Understanding (AI-driven)
    yield { type: 'ai_turn', context: `Understand task: ${task}. Files: ${files.length}` };

    // Phase 3: Planning (spawn planner for complex tasks)
    const needsPlanning = files.length > 50 || task.length > 500;
    if (needsPlanning) {
      const plan = yield { type: 'spawn', agentType: 'planner', task };
      yield { type: 'ai_turn', context: `Follow plan: ${JSON.stringify(plan)}` };
    }

    // Phase 4: Implementation (AI-driven with tool access)
    let implementationComplete = false;
    let attempts = 0;

    while (!implementationComplete && attempts < 10) {
      attempts++;
      const response = yield { type: 'ai_turn' };

      if (response.status === 'complete') {
        implementationComplete = true;
      } else if (response.status === 'needs_research') {
        // Spawn researcher for documentation lookup
        const research = yield {
          type: 'spawn',
          agentType: 'researcher',
          task: response.researchQuery
        };
        yield { type: 'ai_turn', context: `Research results: ${research}` };
      }
    }

    // Phase 5: Verification (deterministic)
    const testResult = yield {
      type: 'tool',
      name: 'bash',
      input: { command: 'npm test -- --passWithNoTests' }
    };

    const typeCheck = yield {
      type: 'tool',
      name: 'bash',
      input: { command: 'npm run typecheck' }
    };

    // Phase 6: Self-review
    if (testResult.exitCode !== 0 || typeCheck.exitCode !== 0) {
      yield {
        type: 'ai_turn',
        context: `Fix failures. Tests: ${testResult.stderr}. Types: ${typeCheck.stderr}`
      };

      // Re-run verification
      const retest = yield { type: 'tool', name: 'bash', input: { command: 'npm test' } };
      if (retest.exitCode !== 0) {
        return { success: false, output: 'Tests still failing after fix attempt' };
      }
    }

    // Phase 7: Completion
    yield { type: 'tool', name: 'bash', input: { command: 'git add -A' } };
    yield { type: 'tool', name: 'bash', input: { command: `git commit -m "${task}"` } };

    return { success: true, output: 'Task completed and committed' };
  },
};
```

## 11. Conclusion

The generator-based agent control pattern provides a powerful way to combine the flexibility of AI with the reliability of deterministic code. By adopting this pattern, factory-factory can:

1. **Guarantee critical workflow steps** always execute
2. **Handle errors gracefully** with try/catch and retry logic
3. **Parallelize independent work** with explicit control
4. **Test workflow logic** independently from AI behavior
5. **Resume workflows** after crashes or interruptions
6. **Observe execution** with clear step-by-step tracing

This pattern is especially valuable for complex, multi-step agent workflows where pure prompt-based control is insufficient.
