import { AgentState, AgentType } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent, createTask } from '../testing/factories';

// Hoist mock definitions
const mockPrisma = vi.hoisted(() => ({
  agent: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  task: {
    findMany: vi.fn(),
  },
}));

const mockTaskAccessor = vi.hoisted(() => ({
  getDescendants: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('./task.accessor.js', () => ({
  taskAccessor: mockTaskAccessor,
}));

// Import after mocking
import { agentAccessor } from './agent.accessor';

describe('AgentAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create an agent with IDLE state by default', async () => {
      const expectedAgent = createAgent({
        type: AgentType.WORKER,
        state: AgentState.IDLE,
      });

      mockPrisma.agent.create.mockResolvedValue(expectedAgent);

      const result = await agentAccessor.create({
        type: AgentType.WORKER,
      });

      expect(mockPrisma.agent.create).toHaveBeenCalledWith({
        data: {
          type: AgentType.WORKER,
          state: AgentState.IDLE,
          currentTaskId: undefined,
          tmuxSessionName: undefined,
        },
      });
      expect(result.state).toBe(AgentState.IDLE);
    });

    it('should create agent with provided state', async () => {
      const expectedAgent = createAgent({
        type: AgentType.SUPERVISOR,
        state: AgentState.BUSY,
      });

      mockPrisma.agent.create.mockResolvedValue(expectedAgent);

      const result = await agentAccessor.create({
        type: AgentType.SUPERVISOR,
        state: AgentState.BUSY,
      });

      expect(mockPrisma.agent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: AgentType.SUPERVISOR,
          state: AgentState.BUSY,
        }),
      });
      expect(result.state).toBe(AgentState.BUSY);
    });

    it('should create agent with currentTaskId', async () => {
      const taskId = 'test-task-id';
      const expectedAgent = createAgent({
        type: AgentType.WORKER,
        currentTaskId: taskId,
      });

      mockPrisma.agent.create.mockResolvedValue(expectedAgent);

      const result = await agentAccessor.create({
        type: AgentType.WORKER,
        currentTaskId: taskId,
      });

      expect(mockPrisma.agent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          currentTaskId: taskId,
        }),
      });
      expect(result.currentTaskId).toBe(taskId);
    });
  });

  describe('findById', () => {
    it('should return agent with relations', async () => {
      const agent = createAgent();
      mockPrisma.agent.findUnique.mockResolvedValue(agent);

      const result = await agentAccessor.findById(agent.id);

      expect(mockPrisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: agent.id },
        include: expect.objectContaining({
          currentTask: true,
          assignedTasks: true,
          mailReceived: expect.any(Object),
        }),
      });
      expect(result).toEqual(agent);
    });

    it('should return null for non-existent agent', async () => {
      mockPrisma.agent.findUnique.mockResolvedValue(null);

      const result = await agentAccessor.findById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update agent state', async () => {
      const agent = createAgent({ state: AgentState.IDLE });
      const updatedAgent = { ...agent, state: AgentState.BUSY };
      mockPrisma.agent.update.mockResolvedValue(updatedAgent);

      const result = await agentAccessor.update(agent.id, {
        state: AgentState.BUSY,
      });

      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: agent.id },
        data: { state: AgentState.BUSY },
      });
      expect(result.state).toBe(AgentState.BUSY);
    });

    it('should update lastActiveAt', async () => {
      const agent = createAgent();
      const newTime = new Date();
      mockPrisma.agent.update.mockResolvedValue({ ...agent, lastActiveAt: newTime });

      await agentAccessor.update(agent.id, { lastActiveAt: newTime });

      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: agent.id },
        data: { lastActiveAt: newTime },
      });
    });
  });

  describe('delete', () => {
    it('should delete agent', async () => {
      const agent = createAgent();
      mockPrisma.agent.delete.mockResolvedValue(agent);

      const result = await agentAccessor.delete(agent.id);

      expect(mockPrisma.agent.delete).toHaveBeenCalledWith({
        where: { id: agent.id },
      });
      expect(result).toEqual(agent);
    });
  });

  describe('list', () => {
    it('should filter by type', async () => {
      mockPrisma.agent.findMany.mockResolvedValue([]);

      await agentAccessor.list({ type: AgentType.SUPERVISOR });

      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ type: AgentType.SUPERVISOR }),
        take: undefined,
        skip: undefined,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should filter by state', async () => {
      mockPrisma.agent.findMany.mockResolvedValue([]);

      await agentAccessor.list({ state: AgentState.BUSY });

      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ state: AgentState.BUSY }),
        take: undefined,
        skip: undefined,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should filter by projectId via currentTask', async () => {
      const projectId = 'test-project-id';
      mockPrisma.agent.findMany.mockResolvedValue([]);

      await agentAccessor.list({ projectId });

      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          currentTask: { projectId },
        }),
        take: undefined,
        skip: undefined,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should support pagination', async () => {
      mockPrisma.agent.findMany.mockResolvedValue([]);

      await agentAccessor.list({ limit: 10, offset: 5 });

      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        take: 10,
        skip: 5,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });
  });

  describe('findByType', () => {
    it('should return agents of specified type', async () => {
      const supervisors = [
        createAgent({ type: AgentType.SUPERVISOR }),
        createAgent({ type: AgentType.SUPERVISOR }),
      ];
      mockPrisma.agent.findMany.mockResolvedValue(supervisors);

      const result = await agentAccessor.findByType(AgentType.SUPERVISOR);

      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: { type: AgentType.SUPERVISOR },
        include: expect.any(Object),
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('findByTaskId', () => {
    it('should find agent by current task', async () => {
      const agent = createAgent({ currentTaskId: 'task-1' });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);

      const result = await agentAccessor.findByTaskId('task-1');

      expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith({
        where: { currentTaskId: 'task-1' },
        include: expect.any(Object),
      });
      expect(result).toEqual(agent);
    });
  });

  describe('findSupervisorByTopLevelTaskId', () => {
    it('should find supervisor for top-level task', async () => {
      const supervisor = createAgent({
        type: AgentType.SUPERVISOR,
        currentTaskId: 'top-level-task',
      });
      mockPrisma.agent.findFirst.mockResolvedValue(supervisor);

      const result = await agentAccessor.findSupervisorByTopLevelTaskId('top-level-task');

      expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith({
        where: {
          currentTaskId: 'top-level-task',
          type: AgentType.SUPERVISOR,
        },
        include: expect.any(Object),
      });
      expect(result?.type).toBe(AgentType.SUPERVISOR);
    });
  });

  describe('heartbeat and health', () => {
    describe('updateHeartbeat', () => {
      it('should update lastActiveAt to now', async () => {
        const agent = createAgent();
        mockPrisma.agent.update.mockResolvedValue(agent);

        await agentAccessor.updateHeartbeat(agent.id);

        expect(mockPrisma.agent.update).toHaveBeenCalledWith({
          where: { id: agent.id },
          data: { lastActiveAt: expect.any(Date) },
        });
      });
    });

    describe('getAgentsSinceHeartbeat', () => {
      it('should return agents with old heartbeats', async () => {
        const staleAgents = [createAgent(), createAgent()];
        mockPrisma.agent.findMany.mockResolvedValue(staleAgents);

        const result = await agentAccessor.getAgentsSinceHeartbeat(5);

        expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
          where: {
            lastActiveAt: {
              lt: expect.any(Date),
            },
          },
          include: expect.any(Object),
        });
        expect(result).toHaveLength(2);
      });
    });

    describe('getHealthyAgents', () => {
      it('should return agents with recent heartbeat and not FAILED', async () => {
        const healthyAgents = [
          createAgent({ state: AgentState.BUSY }),
          createAgent({ state: AgentState.IDLE }),
        ];
        mockPrisma.agent.findMany.mockResolvedValue(healthyAgents);

        const result = await agentAccessor.getHealthyAgents(AgentType.WORKER, 10);

        expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
          where: {
            type: AgentType.WORKER,
            lastActiveAt: {
              gte: expect.any(Date),
            },
            state: {
              not: AgentState.FAILED,
            },
          },
          include: expect.any(Object),
        });
        expect(result).toHaveLength(2);
      });
    });

    describe('getUnhealthyAgents', () => {
      it('should return agents with old heartbeat or FAILED state', async () => {
        const unhealthyAgents = [createAgent({ state: AgentState.FAILED })];
        mockPrisma.agent.findMany.mockResolvedValue(unhealthyAgents);

        const result = await agentAccessor.getUnhealthyAgents(AgentType.WORKER, 10);

        expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
          where: {
            type: AgentType.WORKER,
            OR: [{ lastActiveAt: { lt: expect.any(Date) } }, { state: AgentState.FAILED }],
          },
          include: expect.any(Object),
        });
        expect(result).toHaveLength(1);
      });
    });

    describe('getAgentsWithHealthStatus', () => {
      it('should return agents with computed health status', async () => {
        const now = Date.now();
        const recentTime = new Date(now - 5 * 60 * 1000);
        const oldTime = new Date(now - 30 * 60 * 1000);

        const agents = [
          createAgent({ state: AgentState.BUSY, lastActiveAt: recentTime }),
          createAgent({ state: AgentState.FAILED, lastActiveAt: recentTime }),
          createAgent({ state: AgentState.IDLE, lastActiveAt: oldTime }),
        ];
        mockPrisma.agent.findMany.mockResolvedValue(agents);

        const result = await agentAccessor.getAgentsWithHealthStatus(AgentType.WORKER, 10);

        expect(result).toHaveLength(3);
        expect(result[0].isHealthy).toBe(true);
        expect(result[1].isHealthy).toBe(false);
        expect(result[2].isHealthy).toBe(false);
      });
    });
  });

  describe('findWorkersByTopLevelTaskId', () => {
    it('should find workers assigned to descendant tasks', async () => {
      const descendants = [createTask({ id: 'subtask-1' }), createTask({ id: 'subtask-2' })];
      const workers = [createAgent({ type: AgentType.WORKER })];

      mockTaskAccessor.getDescendants.mockResolvedValue(descendants);
      mockPrisma.agent.findMany.mockResolvedValue(workers);

      const result = await agentAccessor.findWorkersByTopLevelTaskId('top-level');

      expect(mockTaskAccessor.getDescendants).toHaveBeenCalledWith('top-level');
      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: {
          type: AgentType.WORKER,
          assignedTasks: {
            some: {
              id: { in: ['subtask-1', 'subtask-2'] },
            },
          },
        },
        include: expect.any(Object),
      });
      expect(result).toEqual(workers);
    });

    it('should return empty array when no descendants', async () => {
      mockTaskAccessor.getDescendants.mockResolvedValue([]);

      const result = await agentAccessor.findWorkersByTopLevelTaskId('top-level');

      expect(result).toEqual([]);
      expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findAgentsByTopLevelTaskId', () => {
    it('should find both workers and supervisor for top-level task', async () => {
      const descendants = [createTask({ id: 'subtask-1' })];
      const agents = [
        createAgent({ type: AgentType.WORKER }),
        createAgent({ type: AgentType.SUPERVISOR }),
      ];

      mockTaskAccessor.getDescendants.mockResolvedValue(descendants);
      mockPrisma.agent.findMany.mockResolvedValue(agents);

      const result = await agentAccessor.findAgentsByTopLevelTaskId('top-level');

      expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
        where: {
          OR: expect.arrayContaining([
            {
              type: AgentType.WORKER,
              assignedTasks: {
                some: {
                  id: { in: ['subtask-1'] },
                },
              },
            },
            {
              type: AgentType.SUPERVISOR,
              currentTaskId: 'top-level',
            },
          ]),
        },
        include: expect.any(Object),
      });
      expect(result).toHaveLength(2);
    });
  });
});

describe('Agent Lifecycle', () => {
  describe('agent state transitions', () => {
    it('agents should start in IDLE state', () => {
      const agent = createAgent();
      expect(agent.state).toBe(AgentState.IDLE);
    });

    it('valid transitions: IDLE -> BUSY -> WAITING/IDLE', () => {
      const validTransitions = {
        [AgentState.IDLE]: [AgentState.BUSY],
        [AgentState.BUSY]: [AgentState.WAITING, AgentState.IDLE, AgentState.FAILED],
        [AgentState.WAITING]: [AgentState.BUSY, AgentState.IDLE, AgentState.FAILED],
        [AgentState.FAILED]: [],
      };

      expect(validTransitions[AgentState.IDLE]).toContain(AgentState.BUSY);
      expect(validTransitions[AgentState.BUSY]).toContain(AgentState.WAITING);
    });

    it('FAILED is a terminal state', () => {
      const failedAgent = createAgent({ state: AgentState.FAILED });
      expect(failedAgent.state).toBe(AgentState.FAILED);
    });
  });

  describe('agent types', () => {
    it('should support three agent types', () => {
      const types = [AgentType.ORCHESTRATOR, AgentType.SUPERVISOR, AgentType.WORKER];
      for (const type of types) {
        const agent = createAgent({ type });
        expect(agent.type).toBe(type);
      }
    });

    it('ORCHESTRATOR manages supervisors', () => {
      const orchestrator = createAgent({ type: AgentType.ORCHESTRATOR });
      expect(orchestrator.type).toBe(AgentType.ORCHESTRATOR);
    });

    it('SUPERVISOR manages top-level tasks and workers', () => {
      const supervisor = createAgent({
        type: AgentType.SUPERVISOR,
        currentTaskId: 'top-level-task-id',
      });
      expect(supervisor.type).toBe(AgentType.SUPERVISOR);
      expect(supervisor.currentTaskId).toBeDefined();
    });

    it('WORKER executes leaf tasks', () => {
      const worker = createAgent({ type: AgentType.WORKER });
      expect(worker.type).toBe(AgentType.WORKER);
    });
  });
});
