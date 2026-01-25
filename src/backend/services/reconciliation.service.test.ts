/**
 * Comprehensive scenario tests for the Reconciliation Service
 *
 * These tests verify the core reconciliation logic that maintains system consistency.
 * The reconciliation service is critical infrastructure - it ensures:
 * 1. Tasks get supervisors/workers when needed
 * 2. Crashed agents are detected and handled
 * 3. State mismatches are resolved
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mock definitions
const mockAgentAccessor = vi.hoisted(() => ({
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  findSupervisorByTopLevelTaskId: vi.fn(),
  findPotentiallyCrashedAgents: vi.fn(),
  findAgentsNeedingReconciliation: vi.fn(),
  countActiveByType: vi.fn(),
  markAsCrashed: vi.fn(),
  markReconciled: vi.fn(),
  recordReconcileFailure: vi.fn(),
}));

const mockAgentProcessAdapter = vi.hoisted(() => ({
  isRunning: vi.fn(),
}));

const mockTaskAccessor = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  findTopLevelTasksNeedingSupervisors: vi.fn(),
  findLeafTasksNeedingWorkers: vi.fn(),
  findTasksWithMissingInfrastructure: vi.fn(),
  isBlocked: vi.fn(),
  getTopLevelParent: vi.fn(),
  markReconciled: vi.fn(),
  recordReconcileFailure: vi.fn(),
}));

const mockConfigService = vi.hoisted(() => ({
  getSystemConfig: vi.fn(() => ({
    agentHeartbeatThresholdMinutes: 5,
    maxWorkerAttempts: 3,
    crashLoopThresholdMs: 60_000,
    maxRapidCrashes: 3,
    maxConcurrentWorkers: 10,
    maxConcurrentSupervisors: 5,
  })),
}));

const mockGitClientFactory = vi.hoisted(() => ({
  forProject: vi.fn(() => ({
    getWorktreePath: vi.fn((name: string) => `/tmp/worktrees/${name}`),
    createWorktree: vi.fn(() =>
      Promise.resolve({ branchName: 'test-branch', worktreePath: '/tmp/worktrees/test' })
    ),
  })),
}));

vi.mock('../resource_accessors/index.js', () => ({
  agentAccessor: mockAgentAccessor,
  taskAccessor: mockTaskAccessor,
}));

vi.mock('./config.service.js', () => ({
  configService: mockConfigService,
}));

vi.mock('../clients/git.client.js', () => ({
  GitClientFactory: mockGitClientFactory,
}));

vi.mock('../agents/process-adapter.js', () => ({
  agentProcessAdapter: mockAgentProcessAdapter,
}));

vi.mock('./logger.service.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import after mocking
import { AgentType, DesiredExecutionState, ExecutionState, TaskState } from '@prisma-gen/client';
import { createAgent, createProject, createTask } from '../testing/factories.js';

// Import the service after mocks are set up - need dynamic import due to module mocking
// biome-ignore lint/plugin: vitest requires dynamic import after vi.mock()
const { reconciliationService } = await import('./reconciliation.service.js');

describe('ReconciliationService', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default mock returns - empty arrays/null
    mockAgentAccessor.list.mockResolvedValue([]); // For CLI process status checks
    mockAgentAccessor.findPotentiallyCrashedAgents.mockResolvedValue([]);
    mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([]);
    mockAgentAccessor.countActiveByType.mockResolvedValue(0); // Default: no active agents
    mockAgentAccessor.delete.mockResolvedValue({});

    // Default: no agents are running in the process adapter
    mockAgentProcessAdapter.isRunning.mockReturnValue(false);
    mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([]);
    mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([]);
    mockTaskAccessor.findTasksWithMissingInfrastructure.mockResolvedValue([]);
    mockTaskAccessor.markReconciled.mockResolvedValue({});
    mockAgentAccessor.markReconciled.mockResolvedValue({});

    // Reset config to defaults
    mockConfigService.getSystemConfig.mockReturnValue({
      agentHeartbeatThresholdMinutes: 5,
      maxWorkerAttempts: 3,
      crashLoopThresholdMs: 60_000,
      maxRapidCrashes: 3,
      maxConcurrentWorkers: 10,
      maxConcurrentSupervisors: 5,
    });

    // Reset git client factory
    mockGitClientFactory.forProject.mockReturnValue({
      getWorktreePath: vi.fn((name: string) => `/tmp/worktrees/${name}`),
      createWorktree: vi.fn(() =>
        Promise.resolve({ branchName: 'test-branch', worktreePath: '/tmp/worktrees/test' })
      ),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ============================================================================
  // Phase 1: Crash Detection
  // ============================================================================

  describe('Phase 1: Crash Detection', () => {
    it('should mark agents with stale heartbeats as crashed', async () => {
      const staleAgent = createAgent({
        id: 'stale-agent',
        type: AgentType.WORKER,
        executionState: ExecutionState.ACTIVE,
        desiredExecutionState: DesiredExecutionState.ACTIVE,
        lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      });

      mockAgentAccessor.findPotentiallyCrashedAgents.mockResolvedValue([staleAgent]);
      mockAgentAccessor.markAsCrashed.mockResolvedValue({
        ...staleAgent,
        executionState: ExecutionState.CRASHED,
      });

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.markAsCrashed).toHaveBeenCalledWith('stale-agent');
      expect(result.crashesDetected).toBe(1);
    });

    it('should not mark agents with recent heartbeats as crashed', async () => {
      // No stale agents returned
      mockAgentAccessor.findPotentiallyCrashedAgents.mockResolvedValue([]);

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.markAsCrashed).not.toHaveBeenCalled();
      expect(result.crashesDetected).toBe(0);
    });

    it('should detect multiple crashed agents in one cycle', async () => {
      const staleAgents = [
        createAgent({ id: 'stale-1', type: AgentType.WORKER }),
        createAgent({ id: 'stale-2', type: AgentType.WORKER }),
        createAgent({ id: 'stale-3', type: AgentType.SUPERVISOR }),
      ];

      mockAgentAccessor.findPotentiallyCrashedAgents.mockResolvedValue(staleAgents);
      mockAgentAccessor.markAsCrashed.mockResolvedValue({});

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.markAsCrashed).toHaveBeenCalledTimes(3);
      expect(result.crashesDetected).toBe(3);
    });

    it('should continue processing if one crash marking fails', async () => {
      const staleAgents = [createAgent({ id: 'stale-1' }), createAgent({ id: 'stale-2' })];

      mockAgentAccessor.findPotentiallyCrashedAgents.mockResolvedValue(staleAgents);
      mockAgentAccessor.markAsCrashed
        .mockRejectedValueOnce(new Error('Database error'))
        .mockResolvedValueOnce({});

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.markAsCrashed).toHaveBeenCalledTimes(2);
      expect(result.crashesDetected).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        entity: 'agent',
        id: 'stale-1',
        action: 'mark_crashed',
      });
    });
  });

  // ============================================================================
  // Phase 2: Top-Level Task Reconciliation
  // ============================================================================

  describe('Phase 2: Top-Level Task Reconciliation', () => {
    const project = createProject({ id: 'project-1' });

    it('should create supervisor for PLANNING task without one', async () => {
      const task = {
        ...createTask({
          id: 'top-level-1',
          projectId: project.id,
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      const newSupervisor = createAgent({
        id: 'new-supervisor',
        type: AgentType.SUPERVISOR,
        currentTaskId: task.id,
      });

      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
      // First call: check if supervisor exists (returns null → create one)
      // Second call: find supervisor to update worktreePath
      // Third call: count supervisors after reconciliation
      mockAgentAccessor.findSupervisorByTopLevelTaskId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(newSupervisor)
        .mockResolvedValueOnce(newSupervisor);
      mockAgentAccessor.create.mockResolvedValue(newSupervisor);
      mockAgentAccessor.update.mockResolvedValue({});

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.create).toHaveBeenCalledWith({
        type: AgentType.SUPERVISOR,
        currentTaskId: 'top-level-1',
        desiredExecutionState: DesiredExecutionState.ACTIVE,
        executionState: ExecutionState.IDLE,
      });
      expect(result.supervisorsCreated).toBe(1);
    });

    it('should create infrastructure (worktree) for top-level task', async () => {
      const task = {
        ...createTask({
          id: 'top-level-1',
          projectId: project.id,
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      const newSupervisor = createAgent({ id: 'new-supervisor', type: AgentType.SUPERVISOR });
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
      // First call: check if exists (returns null), Second call: find for worktreePath update
      mockAgentAccessor.findSupervisorByTopLevelTaskId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(newSupervisor);
      // Ensure we're under the supervisor limit
      mockAgentAccessor.countActiveByType.mockResolvedValue(0);
      mockAgentAccessor.create.mockResolvedValue(newSupervisor);
      mockAgentAccessor.update.mockResolvedValue({});
      mockTaskAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      expect(mockGitClientFactory.forProject).toHaveBeenCalledWith({
        repoPath: project.repoPath,
        worktreeBasePath: project.worktreeBasePath,
      });
      // Task only gets branchName (worktreePath is now on Agent)
      expect(mockTaskAccessor.update).toHaveBeenCalledWith(
        'top-level-1',
        expect.objectContaining({
          branchName: expect.any(String),
        })
      );
      // Agent gets worktreePath
      expect(mockAgentAccessor.update).toHaveBeenCalledWith(
        'new-supervisor',
        expect.objectContaining({
          worktreePath: expect.any(String),
        })
      );
    });

    it('should not create supervisor if one already exists (healthy)', async () => {
      // Note: findTopLevelTasksNeedingSupervisors only returns tasks that don't have supervisors
      // So if a supervisor already exists for a task, the task won't be in the list.
      // This test verifies that when there are no tasks needing supervisors, none are created.

      // No tasks need supervisors (all have healthy supervisors)
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([]);

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.create).not.toHaveBeenCalled();
      expect(result.supervisorsCreated).toBe(0);
    });

    it('should reset crashed supervisor to trigger restart', async () => {
      const task = {
        ...createTask({
          id: 'top-level-1',
          projectId: project.id,
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      const crashedSupervisor = createAgent({
        id: 'crashed-supervisor',
        type: AgentType.SUPERVISOR,
        executionState: ExecutionState.CRASHED,
        currentTaskId: task.id,
      });

      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
      // Supervisor exists and is crashed - should be reset, not recreated
      mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValue(crashedSupervisor);
      mockAgentAccessor.update.mockResolvedValue({});
      // countActiveByType should NOT be called when supervisor exists

      await reconciliationService.reconcileAll();

      // Should reset the crashed supervisor instead of creating new one
      expect(mockAgentAccessor.update).toHaveBeenCalledWith('crashed-supervisor', {
        desiredExecutionState: DesiredExecutionState.ACTIVE,
        executionState: ExecutionState.IDLE,
      });
      expect(mockAgentAccessor.create).not.toHaveBeenCalled();
      // countActiveByType should not be called when supervisor already exists
      expect(mockAgentAccessor.countActiveByType).not.toHaveBeenCalled();
    });

    it('should not reconcile tasks not in PLANNING state', async () => {
      // Service only looks for PLANNING tasks via findTopLevelTasksNeedingSupervisors
      // So if we return empty, nothing should happen
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([]);

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.create).not.toHaveBeenCalled();
      expect(result.supervisorsCreated).toBe(0);
    });
  });

  // ============================================================================
  // Phase 3: Leaf Task Reconciliation
  // ============================================================================

  describe('Phase 3: Leaf Task Reconciliation', () => {
    const project = createProject({ id: 'project-1' });
    const topLevelTask = createTask({
      id: 'top-level-1',
      projectId: project.id,
      parentId: null,
      state: TaskState.IN_PROGRESS,
      branchName: 'top-level-branch',
    });

    it('should create worker for PENDING unblocked leaf task', async () => {
      const leafTask = {
        ...createTask({
          id: 'leaf-1',
          projectId: project.id,
          parentId: topLevelTask.id,
          state: TaskState.PENDING,
          assignedAgentId: null,
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([leafTask]);
      mockTaskAccessor.isBlocked.mockResolvedValue(false);
      mockTaskAccessor.getTopLevelParent.mockResolvedValue(topLevelTask);
      mockTaskAccessor.update.mockResolvedValue({});
      mockAgentAccessor.create.mockResolvedValue(
        createAgent({
          id: 'new-worker',
          type: AgentType.WORKER,
          currentTaskId: leafTask.id,
        })
      );

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.create).toHaveBeenCalledWith({
        type: AgentType.WORKER,
        currentTaskId: 'leaf-1',
        desiredExecutionState: DesiredExecutionState.ACTIVE,
        executionState: ExecutionState.IDLE,
      });
      expect(mockTaskAccessor.update).toHaveBeenCalledWith(
        'leaf-1',
        expect.objectContaining({
          state: TaskState.IN_PROGRESS,
          assignedAgentId: 'new-worker',
        })
      );
      expect(result.workersCreated).toBe(1);
    });

    it('should mark blocked task as BLOCKED', async () => {
      const blockedTask = {
        ...createTask({
          id: 'blocked-1',
          projectId: project.id,
          parentId: topLevelTask.id,
          state: TaskState.PENDING,
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([blockedTask]);
      mockTaskAccessor.isBlocked.mockResolvedValue(true);
      mockTaskAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      expect(mockTaskAccessor.update).toHaveBeenCalledWith('blocked-1', {
        state: TaskState.BLOCKED,
      });
      expect(mockAgentAccessor.create).not.toHaveBeenCalled();
    });

    it('should create worker for IN_PROGRESS task without one', async () => {
      // Note: findLeafTasksNeedingWorkers only returns PENDING tasks,
      // but the reconcileSingleLeafTask method handles IN_PROGRESS without worker too
      // This scenario is handled when calling reconcileTask directly or when a task
      // in the list has state changed during processing

      const orphanedTask = {
        ...createTask({
          id: 'orphaned-1',
          projectId: project.id,
          parentId: topLevelTask.id,
          state: TaskState.IN_PROGRESS,
          assignedAgentId: null, // In progress but no worker!
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findById.mockResolvedValue(orphanedTask);
      mockTaskAccessor.isBlocked.mockResolvedValue(false);
      mockTaskAccessor.getTopLevelParent.mockResolvedValue(topLevelTask);
      mockTaskAccessor.update.mockResolvedValue({});
      mockAgentAccessor.create.mockResolvedValue(
        createAgent({
          id: 'new-worker',
          type: AgentType.WORKER,
        })
      );

      // Call reconcileTask directly for this scenario
      await reconciliationService.reconcileTask('orphaned-1');

      expect(mockAgentAccessor.create).toHaveBeenCalledWith({
        type: AgentType.WORKER,
        currentTaskId: 'orphaned-1',
        desiredExecutionState: DesiredExecutionState.ACTIVE,
        executionState: ExecutionState.IDLE,
      });
    });

    it('should create infrastructure for task with missing branch', async () => {
      const taskMissingInfra = {
        ...createTask({
          id: 'no-infra-1',
          projectId: project.id,
          parentId: topLevelTask.id,
          state: TaskState.IN_PROGRESS,
          branchName: null, // Missing!
          assignedAgentId: 'some-worker',
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: createAgent({ id: 'some-worker', worktreePath: null }), // Agent with no worktreePath
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findTasksWithMissingInfrastructure.mockResolvedValue([taskMissingInfra]);
      mockTaskAccessor.findById.mockResolvedValue(taskMissingInfra);
      mockTaskAccessor.getTopLevelParent.mockResolvedValue({
        ...topLevelTask,
        branchName: 'top-level-branch',
      });
      mockTaskAccessor.update.mockResolvedValue({});
      mockAgentAccessor.update.mockResolvedValue({});

      const result = await reconciliationService.reconcileAll();

      expect(mockGitClientFactory.forProject).toHaveBeenCalled();
      // Task only gets branchName (worktreePath is now on Agent)
      expect(mockTaskAccessor.update).toHaveBeenCalledWith(
        'no-infra-1',
        expect.objectContaining({
          branchName: expect.any(String),
        })
      );
      // Agent gets worktreePath
      expect(mockAgentAccessor.update).toHaveBeenCalledWith(
        'some-worker',
        expect.objectContaining({
          worktreePath: expect.any(String),
        })
      );
      expect(result.infrastructureCreated).toBeGreaterThan(0);
    });

    it('should handle multiple leaf tasks in one cycle', async () => {
      const task1 = {
        ...createTask({
          id: 'leaf-1',
          projectId: project.id,
          parentId: topLevelTask.id,
          state: TaskState.PENDING,
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };
      const task2 = {
        ...createTask({
          id: 'leaf-2',
          projectId: project.id,
          parentId: topLevelTask.id,
          state: TaskState.PENDING,
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([task1, task2]);
      mockTaskAccessor.isBlocked.mockResolvedValue(false);
      mockTaskAccessor.getTopLevelParent.mockResolvedValue(topLevelTask);
      mockTaskAccessor.update.mockResolvedValue({});
      // Mock findById for race condition checks - return tasks without assignedAgentId
      mockTaskAccessor.findById.mockImplementation((id: string) => {
        if (id === 'leaf-1') {
          return Promise.resolve({ ...task1, assignedAgentId: null });
        }
        if (id === 'leaf-2') {
          return Promise.resolve({ ...task2, assignedAgentId: null });
        }
        return Promise.resolve(null);
      });
      mockAgentAccessor.create
        .mockResolvedValueOnce(createAgent({ id: 'worker-1' }))
        .mockResolvedValueOnce(createAgent({ id: 'worker-2' }));

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.create).toHaveBeenCalledTimes(2);
      expect(result.workersCreated).toBe(2);
    });
  });

  // ============================================================================
  // Concurrency Limit Enforcement
  // ============================================================================

  describe('Concurrency Limit Enforcement', () => {
    const project = createProject({ id: 'project-1' });
    const topLevelTask = createTask({
      id: 'top-level-1',
      projectId: project.id,
      parentId: null,
      state: TaskState.IN_PROGRESS,
      branchName: 'top-level-branch',
    });

    describe('Worker limits', () => {
      it('should skip worker creation when limit is reached', async () => {
        const leafTask = {
          ...createTask({
            id: 'leaf-1',
            projectId: project.id,
            parentId: topLevelTask.id,
            state: TaskState.PENDING,
            assignedAgentId: null,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([leafTask]);
        mockTaskAccessor.isBlocked.mockResolvedValue(false);
        mockTaskAccessor.findById.mockResolvedValue({ ...leafTask, assignedAgentId: null });
        // Simulate 10 active workers (at limit)
        mockAgentAccessor.countActiveByType.mockResolvedValue(10);

        const result = await reconciliationService.reconcileAll();

        expect(mockAgentAccessor.create).not.toHaveBeenCalled();
        expect(result.workersCreated).toBe(0);
        expect(result.workersSkippedDueToLimit).toBe(1);
      });

      it('should create worker when under limit', async () => {
        const leafTask = {
          ...createTask({
            id: 'leaf-1',
            projectId: project.id,
            parentId: topLevelTask.id,
            state: TaskState.PENDING,
            assignedAgentId: null,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([leafTask]);
        mockTaskAccessor.isBlocked.mockResolvedValue(false);
        mockTaskAccessor.getTopLevelParent.mockResolvedValue(topLevelTask);
        mockTaskAccessor.update.mockResolvedValue({});
        mockTaskAccessor.findById.mockResolvedValue({ ...leafTask, assignedAgentId: null });
        // Simulate 5 active workers (under limit of 10)
        mockAgentAccessor.countActiveByType.mockResolvedValue(5);
        mockAgentAccessor.create.mockResolvedValue(
          createAgent({
            id: 'new-worker',
            type: AgentType.WORKER,
            currentTaskId: leafTask.id,
          })
        );

        const result = await reconciliationService.reconcileAll();

        expect(mockAgentAccessor.create).toHaveBeenCalled();
        expect(result.workersCreated).toBe(1);
        expect(result.workersSkippedDueToLimit).toBe(0);
      });

      it('should create workers for tasks up to the limit', async () => {
        const task1 = {
          ...createTask({
            id: 'leaf-1',
            projectId: project.id,
            parentId: topLevelTask.id,
            state: TaskState.PENDING,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };
        const task2 = {
          ...createTask({
            id: 'leaf-2',
            projectId: project.id,
            parentId: topLevelTask.id,
            state: TaskState.PENDING,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };
        const task3 = {
          ...createTask({
            id: 'leaf-3',
            projectId: project.id,
            parentId: topLevelTask.id,
            state: TaskState.PENDING,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([task1, task2, task3]);
        mockTaskAccessor.isBlocked.mockResolvedValue(false);
        mockTaskAccessor.getTopLevelParent.mockResolvedValue(topLevelTask);
        mockTaskAccessor.update.mockResolvedValue({});
        mockTaskAccessor.findById.mockImplementation((id: string) => {
          if (id === 'leaf-1') {
            return Promise.resolve({ ...task1, assignedAgentId: null });
          }
          if (id === 'leaf-2') {
            return Promise.resolve({ ...task2, assignedAgentId: null });
          }
          if (id === 'leaf-3') {
            return Promise.resolve({ ...task3, assignedAgentId: null });
          }
          return Promise.resolve(null);
        });

        // Start at 9 workers, limit is 10
        // First task: 9 active -> creates worker (now 10)
        // Second task: 10 active -> skipped
        // Third task: 10 active -> skipped
        mockAgentAccessor.countActiveByType
          .mockResolvedValueOnce(9) // Check for task 1
          .mockResolvedValueOnce(10) // Check for task 2
          .mockResolvedValueOnce(10); // Check for task 3

        mockAgentAccessor.create.mockResolvedValueOnce(createAgent({ id: 'worker-1' }));

        const result = await reconciliationService.reconcileAll();

        expect(mockAgentAccessor.create).toHaveBeenCalledTimes(1);
        expect(result.workersCreated).toBe(1);
        expect(result.workersSkippedDueToLimit).toBe(2);
      });
    });

    describe('Supervisor limits', () => {
      it('should skip supervisor creation when limit is reached', async () => {
        const task = {
          ...createTask({
            id: 'top-level-2',
            projectId: project.id,
            parentId: null,
            state: TaskState.PLANNING,
          }),
          project,
          parent: null,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
        // No existing supervisor
        mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValue(null);
        // Simulate 5 active supervisors (at limit of 5)
        mockAgentAccessor.countActiveByType.mockImplementation((type) => {
          if (type === AgentType.SUPERVISOR) {
            return Promise.resolve(5);
          }
          return Promise.resolve(0);
        });

        const result = await reconciliationService.reconcileAll();

        expect(mockAgentAccessor.countActiveByType).toHaveBeenCalledWith(AgentType.SUPERVISOR);
        expect(mockAgentAccessor.create).not.toHaveBeenCalled();
        expect(result.supervisorsCreated).toBe(0);
        expect(result.supervisorsSkippedDueToLimit).toBe(1);
      });

      it('should create supervisor when under limit', async () => {
        const task = {
          ...createTask({
            id: 'top-level-2',
            projectId: project.id,
            parentId: null,
            state: TaskState.PLANNING,
          }),
          project,
          parent: null,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        const newSupervisor = createAgent({
          id: 'new-supervisor',
          type: AgentType.SUPERVISOR,
          currentTaskId: task.id,
        });

        mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
        mockAgentAccessor.findSupervisorByTopLevelTaskId
          .mockResolvedValueOnce(null) // Check if exists
          .mockResolvedValueOnce(newSupervisor); // Find for worktreePath update
        // Simulate 3 active supervisors (under limit of 5)
        mockAgentAccessor.countActiveByType.mockResolvedValue(3);
        mockAgentAccessor.create.mockResolvedValue(newSupervisor);
        mockAgentAccessor.update.mockResolvedValue({});
        mockTaskAccessor.update.mockResolvedValue({});

        const result = await reconciliationService.reconcileAll();

        expect(mockAgentAccessor.create).toHaveBeenCalled();
        expect(result.supervisorsCreated).toBe(1);
        expect(result.supervisorsSkippedDueToLimit).toBe(0);
      });
    });

    describe('Configuration integration', () => {
      it('should respect configurable worker limit', async () => {
        // Override config to have a lower limit
        mockConfigService.getSystemConfig.mockReturnValue({
          agentHeartbeatThresholdMinutes: 5,
          maxWorkerAttempts: 3,
          crashLoopThresholdMs: 60_000,
          maxRapidCrashes: 3,
          maxConcurrentWorkers: 2, // Lower limit
          maxConcurrentSupervisors: 5,
        });

        const leafTask = {
          ...createTask({
            id: 'leaf-1',
            projectId: project.id,
            parentId: topLevelTask.id,
            state: TaskState.PENDING,
            assignedAgentId: null,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([leafTask]);
        mockTaskAccessor.isBlocked.mockResolvedValue(false);
        mockTaskAccessor.findById.mockResolvedValue({ ...leafTask, assignedAgentId: null });
        // 2 active workers (at the lower limit)
        mockAgentAccessor.countActiveByType.mockResolvedValue(2);

        const result = await reconciliationService.reconcileAll();

        expect(mockAgentAccessor.create).not.toHaveBeenCalled();
        expect(result.workersSkippedDueToLimit).toBe(1);
      });
    });
  });

  // ============================================================================
  // Phase 4: Agent State Reconciliation
  // ============================================================================

  describe('Phase 4: Agent State Reconciliation', () => {
    it('should transition IDLE agent to ACTIVE when desired', async () => {
      const agent = createAgent({
        id: 'agent-1',
        executionState: ExecutionState.IDLE,
        desiredExecutionState: DesiredExecutionState.ACTIVE,
      });

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([agent]);
      mockAgentAccessor.update.mockResolvedValue({});

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-1', {
        executionState: ExecutionState.ACTIVE,
      });
      expect(result.agentsReconciled).toBe(1);
    });

    it('should transition ACTIVE agent to IDLE when desired', async () => {
      const agent = createAgent({
        id: 'agent-1',
        executionState: ExecutionState.ACTIVE,
        desiredExecutionState: DesiredExecutionState.IDLE,
      });

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([agent]);
      mockAgentAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-1', {
        executionState: ExecutionState.IDLE,
      });
    });

    it('should transition ACTIVE agent to PAUSED when desired', async () => {
      const agent = createAgent({
        id: 'agent-1',
        executionState: ExecutionState.ACTIVE,
        desiredExecutionState: DesiredExecutionState.PAUSED,
      });

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([agent]);
      mockAgentAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-1', {
        executionState: ExecutionState.PAUSED,
      });
    });

    it('should recover CRASHED agent when desired ACTIVE', async () => {
      const crashedAgent = createAgent({
        id: 'crashed-1',
        executionState: ExecutionState.CRASHED,
        desiredExecutionState: DesiredExecutionState.ACTIVE,
      });

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([crashedAgent]);
      mockAgentAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.update).toHaveBeenCalledWith('crashed-1', {
        executionState: ExecutionState.ACTIVE,
      });
    });

    it('should only mark reconciled if states already match', async () => {
      const matchedAgent = createAgent({
        id: 'matched-1',
        executionState: ExecutionState.ACTIVE,
        desiredExecutionState: DesiredExecutionState.ACTIVE,
      });

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([matchedAgent]);

      await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.update).not.toHaveBeenCalled();
      expect(mockAgentAccessor.markReconciled).toHaveBeenCalledWith('matched-1');
    });

    it('should handle multiple agents with different state transitions', async () => {
      const agents = [
        createAgent({
          id: 'agent-1',
          executionState: ExecutionState.IDLE,
          desiredExecutionState: DesiredExecutionState.ACTIVE,
        }),
        createAgent({
          id: 'agent-2',
          executionState: ExecutionState.ACTIVE,
          desiredExecutionState: DesiredExecutionState.PAUSED,
        }),
        createAgent({
          id: 'agent-3',
          executionState: ExecutionState.PAUSED,
          desiredExecutionState: DesiredExecutionState.IDLE,
        }),
      ];

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue(agents);
      mockAgentAccessor.update.mockResolvedValue({});

      const result = await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-1', {
        executionState: ExecutionState.ACTIVE,
      });
      expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-2', {
        executionState: ExecutionState.PAUSED,
      });
      expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-3', {
        executionState: ExecutionState.IDLE,
      });
      expect(result.agentsReconciled).toBe(3);
    });
  });

  // ============================================================================
  // Single Entity Reconciliation (reconcileTask / reconcileAgent)
  // ============================================================================

  describe('Single Entity Reconciliation', () => {
    describe('reconcileTask', () => {
      it('should handle non-existent task gracefully', async () => {
        mockTaskAccessor.findById.mockResolvedValue(null);

        // Should not throw
        await expect(reconciliationService.reconcileTask('nonexistent')).resolves.not.toThrow();
      });

      it('should reconcile top-level task via reconcileSingleTopLevelTask', async () => {
        const project = createProject({ id: 'project-1' });
        const task = {
          ...createTask({
            id: 'top-level-1',
            projectId: project.id,
            parentId: null,
            state: TaskState.PLANNING,
          }),
          project,
          parent: null,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findById.mockResolvedValue(task);
        mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValue(null);
        mockAgentAccessor.create.mockResolvedValue(createAgent({ id: 'new-supervisor' }));
        mockTaskAccessor.update.mockResolvedValue({});

        await reconciliationService.reconcileTask('top-level-1');

        expect(mockAgentAccessor.create).toHaveBeenCalled();
        expect(mockTaskAccessor.markReconciled).toHaveBeenCalledWith('top-level-1');
      });

      it('should reconcile leaf task via reconcileSingleLeafTask', async () => {
        const project = createProject({ id: 'project-1' });
        const topLevelTask = createTask({ id: 'top-level', parentId: null, branchName: 'main' });
        const task = {
          ...createTask({
            id: 'leaf-1',
            projectId: project.id,
            parentId: 'top-level',
            state: TaskState.PENDING,
          }),
          project,
          parent: topLevelTask,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findById.mockResolvedValue(task);
        mockTaskAccessor.isBlocked.mockResolvedValue(false);
        mockTaskAccessor.getTopLevelParent.mockResolvedValue(topLevelTask);
        mockTaskAccessor.update.mockResolvedValue({});
        mockAgentAccessor.create.mockResolvedValue(createAgent({ id: 'new-worker' }));

        await reconciliationService.reconcileTask('leaf-1');

        expect(mockAgentAccessor.create).toHaveBeenCalled();
        expect(mockTaskAccessor.markReconciled).toHaveBeenCalledWith('leaf-1');
      });

      it('should record failure on error', async () => {
        const project = createProject({ id: 'project-1' });
        const task = {
          ...createTask({
            id: 'failing-task',
            projectId: project.id,
            parentId: null,
            state: TaskState.PLANNING,
          }),
          project: null, // Will cause error - no project!
          parent: null,
          children: [],
          assignedAgent: null,
          supervisorAgent: null,
          dependsOn: [],
          dependents: [],
        };

        mockTaskAccessor.findById.mockResolvedValue(task);
        mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValue(null);
        mockAgentAccessor.create.mockResolvedValue(createAgent({ id: 'supervisor' }));
        mockTaskAccessor.recordReconcileFailure.mockResolvedValue({});

        await reconciliationService.reconcileTask('failing-task');

        expect(mockTaskAccessor.recordReconcileFailure).toHaveBeenCalledWith(
          'failing-task',
          expect.stringContaining('no associated project'),
          'reconcile_task'
        );
      });
    });

    describe('reconcileAgent', () => {
      it('should handle non-existent agent gracefully', async () => {
        mockAgentAccessor.findById.mockResolvedValue(null);

        await expect(reconciliationService.reconcileAgent('nonexistent')).resolves.not.toThrow();
      });

      it('should reconcile agent state mismatch', async () => {
        const agent = createAgent({
          id: 'agent-1',
          executionState: ExecutionState.IDLE,
          desiredExecutionState: DesiredExecutionState.ACTIVE,
        });

        mockAgentAccessor.findById.mockResolvedValue(agent);
        mockAgentAccessor.update.mockResolvedValue({});

        await reconciliationService.reconcileAgent('agent-1');

        expect(mockAgentAccessor.update).toHaveBeenCalledWith('agent-1', {
          executionState: ExecutionState.ACTIVE,
        });
        expect(mockAgentAccessor.markReconciled).toHaveBeenCalledWith('agent-1');
      });

      it('should record failure on error', async () => {
        const agent = createAgent({
          id: 'failing-agent',
          executionState: ExecutionState.IDLE,
          desiredExecutionState: DesiredExecutionState.ACTIVE,
        });

        mockAgentAccessor.findById.mockResolvedValue(agent);
        mockAgentAccessor.update.mockRejectedValue(new Error('Database error'));
        mockAgentAccessor.recordReconcileFailure.mockResolvedValue({});

        await reconciliationService.reconcileAgent('failing-agent');

        expect(mockAgentAccessor.recordReconcileFailure).toHaveBeenCalledWith(
          'failing-agent',
          'Database error',
          'reconcile_agent'
        );
      });
    });
  });

  // ============================================================================
  // Full Reconciliation Cycle
  // ============================================================================

  describe('Full Reconciliation Cycle', () => {
    it('should run all four phases in order', async () => {
      const callOrder: string[] = [];

      mockAgentAccessor.findPotentiallyCrashedAgents.mockImplementation(() => {
        callOrder.push('phase1_crash_detection');
        return Promise.resolve([]);
      });
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockImplementation(() => {
        callOrder.push('phase2_top_level');
        return Promise.resolve([]);
      });
      mockTaskAccessor.findLeafTasksNeedingWorkers.mockImplementation(() => {
        callOrder.push('phase3_leaf');
        return Promise.resolve([]);
      });
      mockAgentAccessor.findAgentsNeedingReconciliation.mockImplementation(() => {
        callOrder.push('phase4_agents');
        return Promise.resolve([]);
      });

      await reconciliationService.reconcileAll();

      expect(callOrder).toEqual([
        'phase1_crash_detection',
        'phase2_top_level',
        'phase3_leaf',
        'phase4_agents',
      ]);
    });

    it('should return success when no errors occur', async () => {
      const result = await reconciliationService.reconcileAll();

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return failure when errors occur', async () => {
      mockAgentAccessor.findPotentiallyCrashedAgents.mockRejectedValue(new Error('Phase 1 failed'));

      const result = await reconciliationService.reconcileAll();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should aggregate results from all phases', async () => {
      const project = createProject({ id: 'project-1' });
      const topLevelTask = {
        ...createTask({
          id: 'top-level-1',
          projectId: project.id,
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };
      const leafTask = {
        ...createTask({
          id: 'leaf-1',
          projectId: project.id,
          parentId: 'top-level-1',
          state: TaskState.PENDING,
        }),
        project,
        parent: topLevelTask,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      // Phase 1: One crashed agent
      const staleAgent = createAgent({
        id: 'stale-1',
        executionState: ExecutionState.ACTIVE,
      });
      mockAgentAccessor.findPotentiallyCrashedAgents.mockResolvedValue([staleAgent]);
      mockAgentAccessor.markAsCrashed.mockResolvedValue({});

      // Phase 2: One top-level task needing supervisor
      const newSupervisor = createAgent({ id: 'new-supervisor', type: AgentType.SUPERVISOR });
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([topLevelTask]);
      // First call: check if exists, Second call: find for worktreePath update, Third call: count
      mockAgentAccessor.findSupervisorByTopLevelTaskId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(newSupervisor)
        .mockResolvedValueOnce(newSupervisor);
      mockAgentAccessor.create
        .mockResolvedValueOnce(newSupervisor)
        .mockResolvedValueOnce(createAgent({ id: 'new-worker', type: AgentType.WORKER }));
      mockAgentAccessor.update.mockResolvedValue({});

      // Phase 3: One leaf task needing worker
      mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([leafTask]);
      mockTaskAccessor.isBlocked.mockResolvedValue(false);
      mockTaskAccessor.getTopLevelParent.mockResolvedValue({ ...topLevelTask, branchName: 'main' });
      mockTaskAccessor.update.mockResolvedValue({});

      // Phase 4: One agent needing state change
      const agentNeedingReconcile = createAgent({
        id: 'reconcile-1',
        executionState: ExecutionState.IDLE,
        desiredExecutionState: DesiredExecutionState.ACTIVE,
      });
      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([agentNeedingReconcile]);
      mockAgentAccessor.update.mockResolvedValue({});

      const result = await reconciliationService.reconcileAll();

      expect(result.crashesDetected).toBe(1);
      expect(result.supervisorsCreated).toBe(1);
      expect(result.workersCreated).toBe(1);
      expect(result.agentsReconciled).toBe(1);
      expect(result.tasksReconciled).toBe(2); // top-level + leaf
    });

    it('should continue processing other phases if one phase fails', async () => {
      // Phase 1 fails
      mockAgentAccessor.findPotentiallyCrashedAgents.mockRejectedValue(new Error('Phase 1 error'));

      // But phases 2-4 should still run
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([]);
      mockTaskAccessor.findLeafTasksNeedingWorkers.mockResolvedValue([]);
      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([]);

      const result = await reconciliationService.reconcileAll();

      // All phases should have been attempted
      expect(mockTaskAccessor.findTopLevelTasksNeedingSupervisors).toHaveBeenCalled();
      expect(mockTaskAccessor.findLeafTasksNeedingWorkers).toHaveBeenCalled();
      expect(mockAgentAccessor.findAgentsNeedingReconciliation).toHaveBeenCalled();

      // But result should indicate failure
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Idempotency Tests
  // ============================================================================

  describe('Idempotency', () => {
    it('should produce same result when run twice with no state changes', async () => {
      // First run
      const result1 = await reconciliationService.reconcileAll();

      // Second run (no changes in between)
      const result2 = await reconciliationService.reconcileAll();

      expect(result1).toEqual(result2);
    });

    it('should not create duplicate supervisors', async () => {
      const project = createProject({ id: 'project-1' });
      const task = {
        ...createTask({
          id: 'top-level-1',
          projectId: project.id,
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      const newSupervisor = createAgent({ id: 'supervisor-1', type: AgentType.SUPERVISOR });

      // First run - no supervisor exists
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValueOnce([task]);
      // First call: check if exists (null), Second call: find for worktreePath update
      mockAgentAccessor.findSupervisorByTopLevelTaskId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(newSupervisor);
      mockAgentAccessor.countActiveByType.mockResolvedValue(0); // Under limit
      mockAgentAccessor.create.mockResolvedValueOnce(newSupervisor);
      mockAgentAccessor.update.mockResolvedValue({});
      mockTaskAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      expect(mockAgentAccessor.create).toHaveBeenCalledTimes(1);

      // Second run - supervisor now exists
      const existingSupervisor = createAgent({
        id: 'supervisor-1',
        type: AgentType.SUPERVISOR,
        executionState: ExecutionState.ACTIVE,
      });
      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValueOnce([task]);
      mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValueOnce(existingSupervisor);

      await reconciliationService.reconcileAll();

      // Should still only have created once
      expect(mockAgentAccessor.create).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty database gracefully', async () => {
      const result = await reconciliationService.reconcileAll();

      expect(result.success).toBe(true);
      expect(result.tasksReconciled).toBe(0);
      expect(result.agentsReconciled).toBe(0);
      expect(result.supervisorsCreated).toBe(0);
      expect(result.workersCreated).toBe(0);
      expect(result.crashesDetected).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle task without project when creating infrastructure', async () => {
      const task = {
        ...createTask({
          id: 'no-project-task',
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project: null, // No project!
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
      mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValue(null);
      mockAgentAccessor.create.mockResolvedValue(createAgent({ id: 'supervisor' }));

      const result = await reconciliationService.reconcileAll();

      // Should have recorded an error for this task
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          entity: 'task',
          id: 'no-project-task',
        })
      );
    });

    it('should handle leaf task without top-level parent', async () => {
      const project = createProject({ id: 'project-1' });
      const orphanedLeaf = {
        ...createTask({
          id: 'orphaned-leaf',
          projectId: project.id,
          parentId: 'nonexistent-parent',
          state: TaskState.IN_PROGRESS,
          branchName: null, // Missing branch (worktreePath is now on Agent)
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findTasksWithMissingInfrastructure.mockResolvedValue([orphanedLeaf]);
      mockTaskAccessor.findById.mockResolvedValue(orphanedLeaf);
      mockTaskAccessor.getTopLevelParent.mockResolvedValue(null); // No parent!

      const result = await reconciliationService.reconcileAll();

      expect(result.errors).toContainEqual(
        expect.objectContaining({
          entity: 'task',
          id: 'orphaned-leaf',
        })
      );
    });

    it('should handle git client errors during infrastructure creation', async () => {
      const project = createProject({ id: 'project-1' });
      const task = {
        ...createTask({
          id: 'top-level-1',
          projectId: project.id,
          parentId: null,
          state: TaskState.PLANNING,
        }),
        project,
        parent: null,
        children: [],
        assignedAgent: null,
        supervisorAgent: null,
        dependsOn: [],
        dependents: [],
      };

      mockTaskAccessor.findTopLevelTasksNeedingSupervisors.mockResolvedValue([task]);
      mockAgentAccessor.findSupervisorByTopLevelTaskId.mockResolvedValue(null);
      mockAgentAccessor.create.mockResolvedValue(createAgent({ id: 'supervisor' }));

      // Make git client fail
      mockGitClientFactory.forProject.mockReturnValue({
        getWorktreePath: vi.fn(() => '/tmp/worktrees/test'),
        createWorktree: vi.fn().mockRejectedValue(new Error('Git worktree creation failed')),
      });

      const result = await reconciliationService.reconcileAll();

      expect(result.errors).toContainEqual(
        expect.objectContaining({
          entity: 'task',
          id: 'top-level-1',
          error: expect.stringContaining('Git worktree creation failed'),
        })
      );
    });
  });

  // ============================================================================
  // State Matching Logic
  // ============================================================================

  describe('State Matching Logic', () => {
    it.each([
      [ExecutionState.ACTIVE, DesiredExecutionState.ACTIVE, true],
      [ExecutionState.IDLE, DesiredExecutionState.IDLE, true],
      [ExecutionState.PAUSED, DesiredExecutionState.PAUSED, true],
      [ExecutionState.IDLE, DesiredExecutionState.ACTIVE, false],
      [ExecutionState.ACTIVE, DesiredExecutionState.IDLE, false],
      [ExecutionState.CRASHED, DesiredExecutionState.ACTIVE, false],
      [ExecutionState.ACTIVE, DesiredExecutionState.PAUSED, false],
    ])('should correctly determine match: actual=%s, desired=%s -> %s', async (actual, desired, shouldMatch) => {
      const agent = createAgent({
        id: 'test-agent',
        executionState: actual,
        desiredExecutionState: desired,
      });

      mockAgentAccessor.findAgentsNeedingReconciliation.mockResolvedValue([agent]);
      mockAgentAccessor.update.mockResolvedValue({});

      await reconciliationService.reconcileAll();

      if (shouldMatch) {
        // States match - should only mark reconciled, not update
        expect(mockAgentAccessor.update).not.toHaveBeenCalled();
        expect(mockAgentAccessor.markReconciled).toHaveBeenCalledWith('test-agent');
      } else {
        // States don't match - should update or mark reconciled depending on transition
        // Note: Not all mismatches result in updates (e.g., CRASHED with desired IDLE)
        const updateCalls = mockAgentAccessor.update.mock.calls;
        const markReconciledCalls = mockAgentAccessor.markReconciled.mock.calls;
        expect(updateCalls.length + markReconciledCalls.length).toBeGreaterThan(0);
      }
    });
  });
});
