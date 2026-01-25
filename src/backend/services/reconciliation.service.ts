/**
 * Reconciliation Service
 *
 * The core of the reconciliation-based task infrastructure.
 * Continuously reconciles desired state with actual state,
 * implementing a self-healing, declarative approach.
 *
 * Key principles:
 * 1. Level-triggered, not edge-triggered - continuously check "is reality correct?"
 * 2. Separate task state from agent state
 * 3. Events update state, reconciler acts
 * 4. Hybrid triggering - events trigger immediate reconciliation; periodic cron catches drift
 *
 * Concurrency model:
 * - The reconciliation loop is designed to run single-threaded (one reconcileAll at a time)
 * - Concurrency limit checks (countActiveByType + create) are not atomic, but this is
 *   acceptable because:
 *   a) The reconciler is the only component that creates agents
 *   b) Only one reconciliation cycle runs at a time (enforced by Inngest/cron scheduling)
 *   c) Even if limits are slightly exceeded due to timing, the system self-corrects on
 *      the next cycle as tasks naturally queue when at capacity
 */

import type { Task } from '@prisma-gen/client';
import {
  AgentType,
  CliProcessStatus,
  DesiredExecutionState,
  ExecutionState,
  TaskState,
} from '@prisma-gen/client';
import { GitClientFactory } from '../clients/git.client.js';
import { agentAccessor, taskAccessor } from '../resource_accessors/index.js';
import type { TaskWithRelations } from '../resource_accessors/task.accessor.js';
import { isAgentRunning } from './agent-status.service.js';
import { configService } from './config.service.js';
import { createLogger } from './logger.service.js';

const logger = createLogger('reconciliation');

// ============================================================================
// Types
// ============================================================================

export interface ReconciliationResult {
  success: boolean;
  tasksReconciled: number;
  agentsReconciled: number;
  supervisorsCreated: number;
  workersCreated: number;
  infrastructureCreated: number;
  crashesDetected: number;
  // Concurrency limit tracking
  supervisorsSkippedDueToLimit: number;
  workersSkippedDueToLimit: number;
  errors: Array<{ entity: string; id: string; error: string; action: string }>;
}

export interface TaskReconcileAction {
  taskId: string;
  action:
    | 'create_supervisor'
    | 'create_worker'
    | 'create_infrastructure'
    | 'mark_blocked'
    | 'unblock'
    | 'none';
  reason: string;
}

export interface AgentReconcileAction {
  agentId: string;
  action: 'start' | 'stop' | 'mark_crashed' | 'restart' | 'none';
  reason: string;
}

// ============================================================================
// Reconciliation Service
// ============================================================================

class ReconciliationService {
  /**
   * Main reconciliation loop - runs periodically to ensure system consistency.
   * This is the primary entry point for the reconciler.
   */
  async reconcileAll(): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      success: true,
      tasksReconciled: 0,
      agentsReconciled: 0,
      supervisorsCreated: 0,
      workersCreated: 0,
      infrastructureCreated: 0,
      crashesDetected: 0,
      supervisorsSkippedDueToLimit: 0,
      workersSkippedDueToLimit: 0,
      errors: [],
    };

    logger.info('Starting reconciliation cycle');

    try {
      // Phase 1: Detect crashed agents
      const crashResult = await this.detectAndMarkCrashedAgents();
      result.crashesDetected = crashResult.crashesDetected;
      result.errors.push(...crashResult.errors);

      // Phase 2: Reconcile top-level tasks (supervisors)
      const topLevelResult = await this.reconcileTopLevelTasks();
      result.supervisorsCreated = topLevelResult.supervisorsCreated;
      result.supervisorsSkippedDueToLimit = topLevelResult.supervisorsSkippedDueToLimit;
      result.errors.push(...topLevelResult.errors);

      // Phase 3: Reconcile leaf tasks (workers + infrastructure)
      const leafResult = await this.reconcileLeafTasks();
      result.workersCreated = leafResult.workersCreated;
      result.workersSkippedDueToLimit = leafResult.workersSkippedDueToLimit;
      result.infrastructureCreated = leafResult.infrastructureCreated;
      result.errors.push(...leafResult.errors);

      // Phase 4: Reconcile agent execution states
      const agentResult = await this.reconcileAgentStates();
      result.agentsReconciled = agentResult.agentsReconciled;
      result.errors.push(...agentResult.errors);

      // Calculate totals
      result.tasksReconciled = topLevelResult.tasksReconciled + leafResult.tasksReconciled;
      result.success = result.errors.length === 0;

      logger.info('Reconciliation cycle complete', {
        tasksReconciled: result.tasksReconciled,
        agentsReconciled: result.agentsReconciled,
        supervisorsCreated: result.supervisorsCreated,
        workersCreated: result.workersCreated,
        infrastructureCreated: result.infrastructureCreated,
        crashesDetected: result.crashesDetected,
        supervisorsSkippedDueToLimit: result.supervisorsSkippedDueToLimit,
        workersSkippedDueToLimit: result.workersSkippedDueToLimit,
        errorCount: result.errors.length,
      });
    } catch (error) {
      result.success = false;
      result.errors.push({
        entity: 'system',
        id: 'reconciliation',
        error: error instanceof Error ? error.message : String(error),
        action: 'reconcile_all',
      });
      logger.error('Reconciliation cycle failed', error as Error);
    }

    return result;
  }

  /**
   * Reconcile a single task (called after state changes for immediate reconciliation)
   */
  async reconcileTask(taskId: string): Promise<void> {
    const task = await taskAccessor.findById(taskId);
    if (!task) {
      logger.warn('Task not found for reconciliation', { taskId });
      return;
    }

    logger.debug('Reconciling single task', { taskId, state: task.state });

    try {
      if (task.parentId === null) {
        // Top-level task
        await this.reconcileSingleTopLevelTask(task);
      } else {
        // Leaf task
        await this.reconcileSingleLeafTask(task);
      }

      await taskAccessor.markReconciled(taskId);
    } catch (error) {
      await taskAccessor.recordReconcileFailure(
        taskId,
        error instanceof Error ? error.message : String(error),
        'reconcile_task'
      );
      logger.error('Failed to reconcile task', error as Error, { taskId });
    }
  }

  /**
   * Reconcile a single agent (called after state changes for immediate reconciliation)
   */
  async reconcileAgent(agentId: string): Promise<void> {
    const agent = await agentAccessor.findById(agentId);
    if (!agent) {
      logger.warn('Agent not found for reconciliation', { agentId });
      return;
    }

    logger.debug('Reconciling single agent', {
      agentId,
      executionState: agent.executionState,
      desiredExecutionState: agent.desiredExecutionState,
    });

    try {
      await this.reconcileSingleAgentState(agent);
      await agentAccessor.markReconciled(agentId);
    } catch (error) {
      await agentAccessor.recordReconcileFailure(
        agentId,
        error instanceof Error ? error.message : String(error),
        'reconcile_agent'
      );
      logger.error('Failed to reconcile agent', error as Error, { agentId });
    }
  }

  // ============================================================================
  // Phase 1: Crash Detection
  // ============================================================================

  private async detectAndMarkCrashedAgents(): Promise<{
    crashesDetected: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let crashesDetected = 0;
    const processedIds = new Set<string>();

    try {
      const config = configService.getSystemConfig();
      const heartbeatThreshold = config.agentHeartbeatThresholdMinutes;

      // Step 1: Check agents with CLI process status indicating crash
      const step1 = await this.markAgentsWithCrashedStatus(processedIds);
      crashesDetected += step1.count;
      errors.push(...step1.errors);

      // Step 2: Detect orphaned agents (DB says active but process not in memory)
      const step2 = await this.markOrphanedAgents(processedIds);
      crashesDetected += step2.count;
      errors.push(...step2.errors);

      // Step 3: Find agents with stale heartbeats (fallback detection)
      const step3 = await this.markStaleHeartbeatAgents(heartbeatThreshold, processedIds);
      crashesDetected += step3.count;
      errors.push(...step3.errors);
    } catch (error) {
      errors.push({
        entity: 'system',
        id: 'crash_detection',
        error: error instanceof Error ? error.message : String(error),
        action: 'detect_crashes',
      });
    }

    return { crashesDetected, errors };
  }

  private async markAgentsWithCrashedStatus(processedIds: Set<string>): Promise<{
    count: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let count = 0;
    const agents = await this.detectAgentsWithCrashedProcessStatus();

    for (const agent of agents) {
      try {
        logger.warn('Marking agent as crashed (CLI process status indicates crash)', {
          agentId: agent.id,
          agentType: agent.type,
          cliProcessStatus: agent.cliProcessStatus,
        });
        await agentAccessor.markAsCrashed(agent.id);
        processedIds.add(agent.id);
        count++;
      } catch (error) {
        errors.push({
          entity: 'agent',
          id: agent.id,
          error: error instanceof Error ? error.message : String(error),
          action: 'mark_crashed_process_status',
        });
      }
    }
    return { count, errors };
  }

  private async markOrphanedAgents(processedIds: Set<string>): Promise<{
    count: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let count = 0;
    const agents = await this.detectOrphanedAgents();

    for (const agent of agents) {
      if (processedIds.has(agent.id)) {
        continue;
      }
      try {
        logger.warn('Marking agent as crashed (orphaned - process not found in memory)', {
          agentId: agent.id,
          agentType: agent.type,
          cliProcessId: agent.cliProcessId,
          cliProcessStatus: agent.cliProcessStatus,
        });
        await agentAccessor.markAsCrashed(agent.id);
        processedIds.add(agent.id);
        count++;
      } catch (error) {
        errors.push({
          entity: 'agent',
          id: agent.id,
          error: error instanceof Error ? error.message : String(error),
          action: 'mark_crashed_orphaned',
        });
      }
    }
    return { count, errors };
  }

  private async markStaleHeartbeatAgents(
    heartbeatThreshold: number,
    processedIds: Set<string>
  ): Promise<{
    count: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let count = 0;
    const agents = await agentAccessor.findPotentiallyCrashedAgents(heartbeatThreshold);

    for (const agent of agents) {
      if (processedIds.has(agent.id)) {
        continue;
      }
      try {
        const isActuallyRunning = isAgentRunning(agent.id);
        if (!isActuallyRunning) {
          logger.warn('Marking agent as crashed (stale heartbeat and process not running)', {
            agentId: agent.id,
            agentType: agent.type,
            lastHeartbeat: agent.lastHeartbeat?.toISOString(),
          });
          await agentAccessor.markAsCrashed(agent.id);
          count++;
        } else {
          logger.warn('Agent has stale heartbeat but process is running (may be stuck)', {
            agentId: agent.id,
            agentType: agent.type,
            lastHeartbeat: agent.lastHeartbeat?.toISOString(),
          });
        }
      } catch (error) {
        errors.push({
          entity: 'agent',
          id: agent.id,
          error: error instanceof Error ? error.message : String(error),
          action: 'mark_crashed',
        });
      }
    }
    return { count, errors };
  }

  /**
   * Detect agents whose CLI process status indicates a crash or unexpected exit.
   * This catches cases where the process exited but the exit event properly updated the DB.
   */
  private async detectAgentsWithCrashedProcessStatus(): Promise<
    Array<{
      id: string;
      type: AgentType;
      cliProcessStatus: CliProcessStatus | null;
    }>
  > {
    // Find agents that are supposed to be active but have crashed/killed process status
    const agents = await agentAccessor.list({
      executionState: ExecutionState.ACTIVE,
    });

    return agents.filter((agent) => {
      // Check if CLI process status indicates the process died
      const status = agent.cliProcessStatus;
      return status === CliProcessStatus.CRASHED || status === CliProcessStatus.KILLED;
    });
  }

  /**
   * Detect orphaned agents: DB says they're active but process is not found in memory.
   * This is critical for handling server restarts where all processes are lost.
   *
   * To avoid false positives after server restart, we add a grace period:
   * Only consider an agent orphaned if its process was started more than 2 minutes ago.
   * This gives the reconciler time to restart agents after a server restart.
   */
  private async detectOrphanedAgents(): Promise<
    Array<{
      id: string;
      type: AgentType;
      cliProcessId: string | null;
      cliProcessStatus: CliProcessStatus | null;
    }>
  > {
    const activeAgents = await agentAccessor.list({
      executionState: ExecutionState.ACTIVE,
    });

    return activeAgents
      .filter((agent) => this.isAgentOrphaned(agent))
      .map((agent) => ({
        id: agent.id,
        type: agent.type,
        cliProcessId: agent.cliProcessId,
        cliProcessStatus: agent.cliProcessStatus,
      }));
  }

  /**
   * Check if an agent is orphaned (process not found in memory despite DB saying it's running)
   */
  private isAgentOrphaned(agent: {
    id: string;
    cliProcessStatus: CliProcessStatus | null;
    cliProcessStartedAt: Date | null;
    createdAt: Date;
  }): boolean {
    // Grace period after process start before considering orphaned (2 minutes)
    const ORPHAN_GRACE_PERIOD_MS = 2 * 60 * 1000;
    const now = Date.now();
    const status = agent.cliProcessStatus;

    // Skip agents with crashed/killed status - they're already handled
    if (status === CliProcessStatus.CRASHED || status === CliProcessStatus.KILLED) {
      return false;
    }

    // Skip agents started recently (grace period for server restart)
    const processStartTime = agent.cliProcessStartedAt?.getTime() ?? agent.createdAt.getTime();
    if (now - processStartTime < ORPHAN_GRACE_PERIOD_MS) {
      return false;
    }

    // Only consider running/idle agents - check if process is actually in memory
    const isActiveStatus = status === CliProcessStatus.RUNNING || status === CliProcessStatus.IDLE;
    return isActiveStatus && !isAgentRunning(agent.id);
  }

  // ============================================================================
  // Phase 2: Top-Level Tasks (Supervisors)
  // ============================================================================

  private async reconcileTopLevelTasks(): Promise<{
    tasksReconciled: number;
    supervisorsCreated: number;
    supervisorsSkippedDueToLimit: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let tasksReconciled = 0;
    let supervisorsCreated = 0;
    let supervisorsSkippedDueToLimit = 0;

    try {
      // Find top-level tasks in PLANNING state that need supervisors
      const tasksNeedingSupervisors = await taskAccessor.findTopLevelTasksNeedingSupervisors();

      for (const task of tasksNeedingSupervisors) {
        try {
          const result = await this.reconcileSingleTopLevelTask(task);
          tasksReconciled++;
          if (result.supervisorCreated) {
            supervisorsCreated++;
          }
          if (result.skippedDueToLimit) {
            supervisorsSkippedDueToLimit++;
          }
        } catch (error) {
          errors.push({
            entity: 'task',
            id: task.id,
            error: error instanceof Error ? error.message : String(error),
            action: 'reconcile_top_level',
          });
        }
      }
    } catch (error) {
      errors.push({
        entity: 'system',
        id: 'top_level_reconciliation',
        error: error instanceof Error ? error.message : String(error),
        action: 'reconcile_top_level_tasks',
      });
    }

    return { tasksReconciled, supervisorsCreated, supervisorsSkippedDueToLimit, errors };
  }

  private async reconcileSingleTopLevelTask(
    task: TaskWithRelations
  ): Promise<{ supervisorCreated: boolean; skippedDueToLimit: boolean }> {
    // Only reconcile tasks in PLANNING state that don't have a supervisor
    if (task.state !== TaskState.PLANNING) {
      return { supervisorCreated: false, skippedDueToLimit: false };
    }

    const existingSupervisor = await agentAccessor.findSupervisorByTopLevelTaskId(task.id);
    if (existingSupervisor) {
      // Supervisor exists, check if it's healthy
      if (existingSupervisor.executionState === ExecutionState.CRASHED) {
        // Supervisor crashed - set desired state to ACTIVE to trigger restart
        await agentAccessor.update(existingSupervisor.id, {
          desiredExecutionState: DesiredExecutionState.ACTIVE,
          executionState: ExecutionState.IDLE, // Reset to IDLE so reconciler will start it
        });
        logger.info('Resetting crashed supervisor', {
          agentId: existingSupervisor.id,
          taskId: task.id,
        });
      }
      return { supervisorCreated: false, skippedDueToLimit: false };
    }

    // Check concurrency limit before creating supervisor
    const config = configService.getSystemConfig();
    const activeSupervisors = await agentAccessor.countActiveByType(AgentType.SUPERVISOR);

    if (activeSupervisors >= config.maxConcurrentSupervisors) {
      logger.info('Supervisor limit reached, task will wait for capacity', {
        taskId: task.id,
        title: task.title,
        activeSupervisors,
        limit: config.maxConcurrentSupervisors,
      });
      return { supervisorCreated: false, skippedDueToLimit: true };
    }

    // Create supervisor agent
    logger.info('Creating supervisor for top-level task', { taskId: task.id, title: task.title });

    await agentAccessor.create({
      type: AgentType.SUPERVISOR,
      currentTaskId: task.id,
      desiredExecutionState: DesiredExecutionState.ACTIVE, // We want it to run
      executionState: ExecutionState.IDLE, // It will be started by agent reconciliation
    });

    // Create worktree and branch for the top-level task
    await this.createTopLevelTaskInfrastructure(task);

    await taskAccessor.markReconciled(task.id);
    return { supervisorCreated: true, skippedDueToLimit: false };
  }

  private async createTopLevelTaskInfrastructure(task: TaskWithRelations): Promise<void> {
    const project = task.project;
    if (!project) {
      throw new Error(`Task ${task.id} has no associated project`);
    }

    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreeName = `top-level-${task.id}`;
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    try {
      // Create worktree for top-level task
      const worktreeInfo = await gitClient.createWorktree(worktreeName, project.defaultBranch);
      const branchName = worktreeInfo.branchName;

      // Update task with branch info (worktreePath is stored on the supervisor agent)
      await taskAccessor.update(task.id, {
        branchName,
      });

      // Update supervisor agent with worktreePath
      const supervisor = await agentAccessor.findSupervisorByTopLevelTaskId(task.id);
      if (supervisor) {
        await agentAccessor.update(supervisor.id, {
          worktreePath,
        });
      }

      logger.info('Created top-level task infrastructure', {
        taskId: task.id,
        worktreePath,
        branchName,
      });
    } catch (error) {
      logger.error('Failed to create top-level task infrastructure', error as Error, {
        taskId: task.id,
      });
      throw error;
    }
  }

  // ============================================================================
  // Phase 3: Leaf Tasks (Workers + Infrastructure)
  // ============================================================================

  private async reconcileLeafTasks(): Promise<{
    tasksReconciled: number;
    workersCreated: number;
    workersSkippedDueToLimit: number;
    infrastructureCreated: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let tasksReconciled = 0;
    let workersCreated = 0;
    let workersSkippedDueToLimit = 0;
    let infrastructureCreated = 0;

    try {
      // Reconcile tasks that need workers
      const workerResult = await this.reconcileTasksNeedingWorkers();
      tasksReconciled += workerResult.tasksReconciled;
      workersCreated += workerResult.workersCreated;
      workersSkippedDueToLimit += workerResult.workersSkippedDueToLimit;
      infrastructureCreated += workerResult.infrastructureCreated;
      errors.push(...workerResult.errors);

      // Reconcile tasks with missing infrastructure
      const infraResult = await this.reconcileTasksWithMissingInfrastructure();
      infrastructureCreated += infraResult.infrastructureCreated;
      errors.push(...infraResult.errors);
    } catch (error) {
      errors.push({
        entity: 'system',
        id: 'leaf_task_reconciliation',
        error: error instanceof Error ? error.message : String(error),
        action: 'reconcile_leaf_tasks',
      });
    }

    return {
      tasksReconciled,
      workersCreated,
      workersSkippedDueToLimit,
      infrastructureCreated,
      errors,
    };
  }

  private async reconcileTasksNeedingWorkers(): Promise<{
    tasksReconciled: number;
    workersCreated: number;
    workersSkippedDueToLimit: number;
    infrastructureCreated: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let tasksReconciled = 0;
    let workersCreated = 0;
    let workersSkippedDueToLimit = 0;
    let infrastructureCreated = 0;

    const tasksNeedingWorkers = await taskAccessor.findLeafTasksNeedingWorkers();

    for (const task of tasksNeedingWorkers) {
      try {
        const result = await this.reconcileSingleLeafTask(task);
        tasksReconciled++;
        if (result.workerCreated) {
          workersCreated++;
        }
        if (result.skippedDueToLimit) {
          workersSkippedDueToLimit++;
        }
        if (result.infrastructureCreated) {
          infrastructureCreated++;
        }
      } catch (error) {
        errors.push({
          entity: 'task',
          id: task.id,
          error: error instanceof Error ? error.message : String(error),
          action: 'reconcile_leaf_task',
        });
      }
    }

    return {
      tasksReconciled,
      workersCreated,
      workersSkippedDueToLimit,
      infrastructureCreated,
      errors,
    };
  }

  private async reconcileTasksWithMissingInfrastructure(): Promise<{
    infrastructureCreated: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let infrastructureCreated = 0;

    const tasksWithMissingInfra = await taskAccessor.findTasksWithMissingInfrastructure();

    for (const task of tasksWithMissingInfra) {
      try {
        const { worktreePath } = await this.ensureLeafTaskInfrastructure(task);
        // Update the agent with worktreePath if one exists
        if (task.assignedAgentId) {
          await agentAccessor.update(task.assignedAgentId, { worktreePath });
        }
        infrastructureCreated++;
      } catch (error) {
        errors.push({
          entity: 'task',
          id: task.id,
          error: error instanceof Error ? error.message : String(error),
          action: 'create_infrastructure',
        });
      }
    }

    return { infrastructureCreated, errors };
  }

  private async reconcileSingleLeafTask(task: TaskWithRelations): Promise<{
    workerCreated: boolean;
    skippedDueToLimit: boolean;
    infrastructureCreated: boolean;
  }> {
    // Handle blocked tasks
    if (await this.handleBlockedTask(task)) {
      return { workerCreated: false, skippedDueToLimit: false, infrastructureCreated: false };
    }

    // Handle PENDING tasks that need workers
    if (task.state === TaskState.PENDING && !task.assignedAgentId) {
      return this.createWorkerForPendingTask(task);
    }

    // Handle IN_PROGRESS tasks that lost their worker
    if (task.state === TaskState.IN_PROGRESS && !task.assignedAgentId) {
      return this.createWorkerForOrphanedTask(task);
    }

    // Ensure infrastructure for IN_PROGRESS tasks missing branchName
    // (worktreePath on agent will be set when infrastructure is created)
    if (task.state === TaskState.IN_PROGRESS && !task.branchName) {
      const { worktreePath } = await this.ensureLeafTaskInfrastructure(task);
      // Update the agent with worktreePath if one exists
      if (task.assignedAgentId) {
        await agentAccessor.update(task.assignedAgentId, { worktreePath });
      }
      await taskAccessor.markReconciled(task.id);
      return { workerCreated: false, skippedDueToLimit: false, infrastructureCreated: true };
    }

    await taskAccessor.markReconciled(task.id);
    return { workerCreated: false, skippedDueToLimit: false, infrastructureCreated: false };
  }

  /**
   * Check if task is blocked and update state if needed.
   * Returns true if task was handled (is blocked), false otherwise.
   */
  private async handleBlockedTask(task: TaskWithRelations): Promise<boolean> {
    const isBlocked = await taskAccessor.isBlocked(task.id);
    if (isBlocked && task.state === TaskState.PENDING) {
      await taskAccessor.update(task.id, { state: TaskState.BLOCKED });
      return true;
    }
    return false;
  }

  /**
   * Check if worker concurrency limit has been reached.
   * Logs when limit is reached and returns limit information for tracking.
   */
  private async checkWorkerLimit(task: TaskWithRelations): Promise<{
    limitReached: boolean;
    activeWorkers: number;
    limit: number;
  }> {
    const config = configService.getSystemConfig();
    const activeWorkers = await agentAccessor.countActiveByType(AgentType.WORKER);
    const limitReached = activeWorkers >= config.maxConcurrentWorkers;

    if (limitReached) {
      logger.info('Worker limit reached, task will wait for capacity', {
        taskId: task.id,
        title: task.title,
        activeWorkers,
        limit: config.maxConcurrentWorkers,
      });
    }

    return { limitReached, activeWorkers, limit: config.maxConcurrentWorkers };
  }

  /**
   * Create a worker for a PENDING task and transition it to IN_PROGRESS.
   */
  private async createWorkerForPendingTask(task: TaskWithRelations): Promise<{
    workerCreated: boolean;
    skippedDueToLimit: boolean;
    infrastructureCreated: boolean;
  }> {
    // Re-fetch task to check for race condition
    const freshTask = await taskAccessor.findById(task.id);
    if (freshTask?.assignedAgentId) {
      logger.debug('Task already has agent assigned (race condition avoided)', { taskId: task.id });
      return { workerCreated: false, skippedDueToLimit: false, infrastructureCreated: false };
    }

    // Check concurrency limit before creating worker
    const { limitReached } = await this.checkWorkerLimit(task);
    if (limitReached) {
      return { workerCreated: false, skippedDueToLimit: true, infrastructureCreated: false };
    }

    logger.info('Creating worker for leaf task', { taskId: task.id, title: task.title });

    // Create worker agent first
    const worker = await agentAccessor.create({
      type: AgentType.WORKER,
      currentTaskId: task.id,
      desiredExecutionState: DesiredExecutionState.ACTIVE,
      executionState: ExecutionState.IDLE,
    });

    try {
      // Create infrastructure and update agent with worktreePath
      const { worktreePath } = await this.ensureLeafTaskInfrastructure(task);
      await agentAccessor.update(worker.id, { worktreePath });

      // Update task state and assign agent
      await taskAccessor.update(task.id, {
        state: TaskState.IN_PROGRESS,
        assignedAgentId: worker.id,
      });

      await taskAccessor.markReconciled(task.id);
      return { workerCreated: true, skippedDueToLimit: false, infrastructureCreated: true };
    } catch (error) {
      // Clean up orphaned agent if infrastructure creation fails
      logger.error('Infrastructure creation failed, cleaning up agent', error as Error, {
        taskId: task.id,
        agentId: worker.id,
      });
      await agentAccessor.delete(worker.id);
      throw error;
    }
  }

  /**
   * Create a worker for an IN_PROGRESS task that has no assigned agent.
   */
  private async createWorkerForOrphanedTask(task: TaskWithRelations): Promise<{
    workerCreated: boolean;
    skippedDueToLimit: boolean;
    infrastructureCreated: boolean;
  }> {
    // Re-fetch task to check for race condition
    const freshTask = await taskAccessor.findById(task.id);
    if (freshTask?.assignedAgentId) {
      logger.debug('Task already has agent assigned (race condition avoided)', { taskId: task.id });
      return { workerCreated: false, skippedDueToLimit: false, infrastructureCreated: false };
    }

    // Check concurrency limit before creating worker
    const { limitReached } = await this.checkWorkerLimit(task);
    if (limitReached) {
      return { workerCreated: false, skippedDueToLimit: true, infrastructureCreated: false };
    }

    logger.info('Creating missing worker for IN_PROGRESS task', {
      taskId: task.id,
      title: task.title,
    });

    // Create worker agent first
    const worker = await agentAccessor.create({
      type: AgentType.WORKER,
      currentTaskId: task.id,
      desiredExecutionState: DesiredExecutionState.ACTIVE,
      executionState: ExecutionState.IDLE,
    });

    try {
      let infrastructureCreated = false;

      // Ensure infrastructure exists and update agent with worktreePath
      if (!task.branchName) {
        const { worktreePath } = await this.ensureLeafTaskInfrastructure(task);
        await agentAccessor.update(worker.id, { worktreePath });
        infrastructureCreated = true;
      }

      await taskAccessor.update(task.id, { assignedAgentId: worker.id });
      await taskAccessor.markReconciled(task.id);

      return { workerCreated: true, skippedDueToLimit: false, infrastructureCreated };
    } catch (error) {
      // Clean up orphaned agent if infrastructure creation fails
      logger.error('Failed to set up orphaned task worker, cleaning up agent', error as Error, {
        taskId: task.id,
        agentId: worker.id,
      });
      await agentAccessor.delete(worker.id);
      throw error;
    }
  }

  private async ensureLeafTaskInfrastructure(
    task: TaskWithRelations | Task
  ): Promise<{ worktreePath: string; branchName: string }> {
    // Get full task with project if not already loaded
    const fullTask =
      'project' in task && task.project ? task : await taskAccessor.findById(task.id);
    if (!fullTask?.project) {
      throw new Error(`Task ${task.id} has no associated project`);
    }

    const project = fullTask.project;
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    // Get the top-level task's branch as the base
    const topLevelTask = await taskAccessor.getTopLevelParent(task.id);
    if (!topLevelTask) {
      throw new Error(`Task ${task.id} has no top-level parent`);
    }

    const baseBranch = topLevelTask.branchName ?? project.defaultBranch;
    const worktreeName = `task-${task.id}`;
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    try {
      // Create worktree
      const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch);
      const branchName = worktreeInfo.branchName;

      // Update task with branch info only (worktreePath is stored on agent)
      await taskAccessor.update(task.id, {
        branchName,
      });

      logger.info('Created leaf task infrastructure', {
        taskId: task.id,
        worktreePath,
        branchName,
        baseBranch,
      });

      return { worktreePath, branchName };
    } catch (error) {
      logger.error('Failed to create leaf task infrastructure', error as Error, {
        taskId: task.id,
      });
      throw error;
    }
  }

  // ============================================================================
  // Phase 4: Agent States
  // ============================================================================

  private async reconcileAgentStates(): Promise<{
    agentsReconciled: number;
    errors: ReconciliationResult['errors'];
  }> {
    const errors: ReconciliationResult['errors'] = [];
    let agentsReconciled = 0;

    try {
      // Find agents that need reconciliation
      const agentsNeedingReconciliation = await agentAccessor.findAgentsNeedingReconciliation();

      for (const agent of agentsNeedingReconciliation) {
        try {
          await this.reconcileSingleAgentState(agent);
          agentsReconciled++;
        } catch (error) {
          errors.push({
            entity: 'agent',
            id: agent.id,
            error: error instanceof Error ? error.message : String(error),
            action: 'reconcile_agent_state',
          });
        }
      }
    } catch (error) {
      errors.push({
        entity: 'system',
        id: 'agent_state_reconciliation',
        error: error instanceof Error ? error.message : String(error),
        action: 'reconcile_agent_states',
      });
    }

    return { agentsReconciled, errors };
  }

  private async reconcileSingleAgentState(agent: {
    id: string;
    type: AgentType;
    executionState: ExecutionState;
    desiredExecutionState: DesiredExecutionState;
  }): Promise<void> {
    const { id, executionState, desiredExecutionState } = agent;

    // If actual matches desired, nothing to do
    if (this.statesMatch(executionState, desiredExecutionState)) {
      await agentAccessor.markReconciled(id);
      return;
    }

    logger.debug('Reconciling agent state mismatch', {
      agentId: id,
      executionState,
      desiredExecutionState,
    });

    // Apply the appropriate state transition
    await this.applyAgentStateTransition(id, executionState, desiredExecutionState);
    await agentAccessor.markReconciled(id);
  }

  /**
   * Apply the appropriate state transition based on desired state.
   * Note: Actual agent starting/stopping is handled by the agent lifecycle module.
   * The reconciler just sets the state, the lifecycle module watches for this.
   */
  private async applyAgentStateTransition(
    agentId: string,
    actual: ExecutionState,
    desired: DesiredExecutionState
  ): Promise<void> {
    switch (desired) {
      case DesiredExecutionState.ACTIVE:
        await this.transitionToActive(agentId, actual);
        break;
      case DesiredExecutionState.IDLE:
        await this.transitionToIdle(agentId, actual);
        break;
      case DesiredExecutionState.PAUSED:
        await this.transitionToPaused(agentId, actual);
        break;
    }
  }

  private async transitionToActive(agentId: string, actual: ExecutionState): Promise<void> {
    if (
      actual === ExecutionState.IDLE ||
      actual === ExecutionState.CRASHED ||
      actual === ExecutionState.PAUSED
    ) {
      await agentAccessor.update(agentId, { executionState: ExecutionState.ACTIVE });
      const action =
        actual === ExecutionState.PAUSED ? 'resumed from paused state' : 'marked for activation';
      logger.info(`Agent ${action}`, { agentId });
    }
  }

  private async transitionToIdle(agentId: string, actual: ExecutionState): Promise<void> {
    if (
      actual === ExecutionState.ACTIVE ||
      actual === ExecutionState.PAUSED ||
      actual === ExecutionState.CRASHED
    ) {
      await agentAccessor.update(agentId, { executionState: ExecutionState.IDLE });
      logger.info('Agent marked for deactivation', { agentId });
    }
  }

  private async transitionToPaused(agentId: string, actual: ExecutionState): Promise<void> {
    if (actual === ExecutionState.ACTIVE) {
      await agentAccessor.update(agentId, { executionState: ExecutionState.PAUSED });
      logger.info('Agent marked as paused', { agentId });
    } else if (actual === ExecutionState.IDLE) {
      // Can't pause an idle agent - it needs to be active first
      logger.debug('Cannot pause idle agent, skipping', { agentId });
    }
  }

  private statesMatch(actual: ExecutionState, desired: DesiredExecutionState): boolean {
    switch (desired) {
      case DesiredExecutionState.ACTIVE:
        return actual === ExecutionState.ACTIVE;
      case DesiredExecutionState.IDLE:
        return actual === ExecutionState.IDLE;
      case DesiredExecutionState.PAUSED:
        return actual === ExecutionState.PAUSED;
      default:
        return false;
    }
  }
}

// Export singleton instance
export const reconciliationService = new ReconciliationService();
