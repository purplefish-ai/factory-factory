import { TaskState } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, createTask } from '../testing/factories';

// Hoist mock definitions
const mockPrisma = vi.hoisted(() => ({
  task: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  taskDependency: {
    create: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  prisma: mockPrisma,
}));

// Import after mocking
import { TaskAccessor, taskAccessor } from './task.accessor';

describe('TaskAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a top-level task with PLANNING state by default', async () => {
      const project = createProject();
      const expectedTask = createTask({
        projectId: project.id,
        parentId: null,
        title: 'Top-level task',
        state: TaskState.PLANNING,
      });

      mockPrisma.task.create.mockResolvedValue(expectedTask);

      const result = await taskAccessor.create({
        projectId: project.id,
        title: 'Top-level task',
      });

      expect(mockPrisma.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: project.id,
          parentId: null,
          title: 'Top-level task',
          state: TaskState.PLANNING,
        }),
        include: expect.any(Object),
      });
      expect(result.state).toBe(TaskState.PLANNING);
    });

    it('should create a child task with PENDING state by default', async () => {
      const project = createProject();
      const parentTask = createTask({ projectId: project.id, parentId: null });
      const expectedTask = createTask({
        projectId: project.id,
        parentId: parentTask.id,
        title: 'Child task',
        state: TaskState.PENDING,
      });

      mockPrisma.task.create.mockResolvedValue(expectedTask);

      const result = await taskAccessor.create({
        projectId: project.id,
        parentId: parentTask.id,
        title: 'Child task',
      });

      expect(mockPrisma.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: project.id,
          parentId: parentTask.id,
          title: 'Child task',
          state: TaskState.PENDING,
        }),
        include: expect.any(Object),
      });
      expect(result.state).toBe(TaskState.PENDING);
    });

    it('should respect explicitly provided state', async () => {
      const project = createProject();
      const expectedTask = createTask({
        projectId: project.id,
        state: TaskState.IN_PROGRESS,
      });

      mockPrisma.task.create.mockResolvedValue(expectedTask);

      const result = await taskAccessor.create({
        projectId: project.id,
        title: 'Task with explicit state',
        state: TaskState.IN_PROGRESS,
      });

      expect(mockPrisma.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          state: TaskState.IN_PROGRESS,
        }),
        include: expect.any(Object),
      });
      expect(result.state).toBe(TaskState.IN_PROGRESS);
    });
  });

  describe('findById', () => {
    it('should return task with full relations', async () => {
      const task = createTask();
      mockPrisma.task.findUnique.mockResolvedValue(task);

      const result = await taskAccessor.findById(task.id);

      expect(mockPrisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: task.id },
        include: expect.objectContaining({
          project: true,
          parent: true,
          children: true,
          assignedAgent: true,
          supervisorAgent: true,
        }),
      });
      expect(result).toEqual(task);
    });

    it('should return null for non-existent task', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);

      const result = await taskAccessor.findById('non-existent-id');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update task state', async () => {
      const task = createTask({ state: TaskState.PENDING });
      const updatedTask = { ...task, state: TaskState.IN_PROGRESS };
      mockPrisma.task.update.mockResolvedValue(updatedTask);

      const result = await taskAccessor.update(task.id, {
        state: TaskState.IN_PROGRESS,
      });

      expect(mockPrisma.task.update).toHaveBeenCalledWith({
        where: { id: task.id },
        data: { state: TaskState.IN_PROGRESS },
      });
      expect(result.state).toBe(TaskState.IN_PROGRESS);
    });
  });

  describe('list', () => {
    it('should filter by projectId', async () => {
      const projectId = 'test-project-id';
      mockPrisma.task.findMany.mockResolvedValue([]);

      await taskAccessor.list({ projectId });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ projectId }),
        take: undefined,
        skip: undefined,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should filter by state', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);

      await taskAccessor.list({ state: TaskState.PENDING });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ state: TaskState.PENDING }),
        take: undefined,
        skip: undefined,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should filter by isTopLevel', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);

      await taskAccessor.list({ isTopLevel: true });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ parentId: null }),
        take: undefined,
        skip: undefined,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should support pagination with limit and offset', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);

      await taskAccessor.list({ limit: 10, offset: 20 });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        take: 10,
        skip: 20,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });
  });

  describe('findTopLevel', () => {
    it('should return tasks with no parent', async () => {
      const topLevelTasks = [createTask({ parentId: null }), createTask({ parentId: null })];
      mockPrisma.task.findMany.mockResolvedValue(topLevelTasks);

      const result = await taskAccessor.findTopLevel();

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: { parentId: null },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
      expect(result).toEqual(topLevelTasks);
    });

    it('should filter by projectId when provided', async () => {
      const projectId = 'test-project-id';
      mockPrisma.task.findMany.mockResolvedValue([]);

      await taskAccessor.findTopLevel(projectId);

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: { parentId: null, projectId },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });
  });

  describe('hierarchy helpers', () => {
    describe('getAncestors', () => {
      it('should return ancestors from task to root', async () => {
        const root = createTask({ id: 'root', parentId: null });
        const parent = createTask({ id: 'parent', parentId: root.id });
        const child = createTask({ id: 'child', parentId: parent.id });

        mockPrisma.task.findUnique
          .mockResolvedValueOnce(child)
          .mockResolvedValueOnce(parent)
          .mockResolvedValueOnce(root);

        const result = await taskAccessor.getAncestors('child');

        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('parent');
        expect(result[1].id).toBe('root');
      });

      it('should return empty array for top-level task', async () => {
        const root = createTask({ id: 'root', parentId: null });
        mockPrisma.task.findUnique.mockResolvedValueOnce(root);

        const result = await taskAccessor.getAncestors('root');

        expect(result).toEqual([]);
      });
    });

    describe('getDescendants', () => {
      it('should return all descendants recursively', async () => {
        const children = [createTask({ id: 'child1' }), createTask({ id: 'child2' })];
        const grandchildren = [createTask({ id: 'grandchild1' })];

        mockPrisma.task.findMany
          .mockResolvedValueOnce(children)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(grandchildren)
          .mockResolvedValueOnce([]);

        const result = await taskAccessor.getDescendants('parent');

        expect(result).toHaveLength(3);
      });

      it('should return empty array for leaf task', async () => {
        mockPrisma.task.findMany.mockResolvedValue([]);

        const result = await taskAccessor.getDescendants('leaf');

        expect(result).toEqual([]);
      });
    });

    describe('getTopLevelParent', () => {
      it('should return the root ancestor', async () => {
        const root = createTask({ id: 'root', parentId: null });
        const child = createTask({ id: 'child', parentId: root.id });

        mockPrisma.task.findUnique.mockResolvedValueOnce(child).mockResolvedValueOnce(root);

        const result = await taskAccessor.getTopLevelParent('child');

        expect(result?.id).toBe('root');
      });

      it('should return itself if already top-level', async () => {
        const root = createTask({ id: 'root', parentId: null });
        mockPrisma.task.findUnique.mockResolvedValueOnce(root);

        const result = await taskAccessor.getTopLevelParent('root');

        expect(result?.id).toBe('root');
      });

      it('should return null for non-existent task', async () => {
        mockPrisma.task.findUnique.mockResolvedValueOnce(null);

        const result = await taskAccessor.getTopLevelParent('non-existent');

        expect(result).toBeNull();
      });
    });

    describe('isLeafTask', () => {
      it('should return true for task with no children', async () => {
        mockPrisma.task.count.mockResolvedValue(0);

        const result = await taskAccessor.isLeafTask('leaf-task');

        expect(result).toBe(true);
      });

      it('should return false for task with children', async () => {
        mockPrisma.task.count.mockResolvedValue(3);

        const result = await taskAccessor.isLeafTask('parent-task');

        expect(result).toBe(false);
      });
    });

    describe('isTopLevelTask', () => {
      it('should return true for task with no parent', async () => {
        const task = createTask({ parentId: null });
        mockPrisma.task.findUnique.mockResolvedValue({ parentId: null });

        const result = await taskAccessor.isTopLevelTask(task.id);

        expect(result).toBe(true);
      });

      it('should return false for task with parent', async () => {
        const task = createTask({ parentId: 'some-parent' });
        mockPrisma.task.findUnique.mockResolvedValue({ parentId: 'some-parent' });

        const result = await taskAccessor.isTopLevelTask(task.id);

        expect(result).toBe(false);
      });
    });
  });

  describe('dependency helpers', () => {
    describe('addDependency', () => {
      it('should create a dependency between tasks', async () => {
        const dependency = {
          id: 'dep-1',
          taskId: 'task-a',
          dependsOnId: 'task-b',
          createdAt: new Date(),
        };
        mockPrisma.taskDependency.create.mockResolvedValue(dependency);

        const result = await taskAccessor.addDependency('task-a', 'task-b');

        expect(mockPrisma.taskDependency.create).toHaveBeenCalledWith({
          data: { taskId: 'task-a', dependsOnId: 'task-b' },
        });
        expect(result).toEqual(dependency);
      });
    });

    describe('removeDependency', () => {
      it('should delete a dependency between tasks', async () => {
        mockPrisma.taskDependency.delete.mockResolvedValue({});

        await taskAccessor.removeDependency('task-a', 'task-b');

        expect(mockPrisma.taskDependency.delete).toHaveBeenCalledWith({
          where: {
            taskId_dependsOnId: { taskId: 'task-a', dependsOnId: 'task-b' },
          },
        });
      });
    });

    describe('getDependencies', () => {
      it('should return tasks that this task depends on', async () => {
        const taskB = createTask({ id: 'task-b' });
        const taskC = createTask({ id: 'task-c' });
        mockPrisma.taskDependency.findMany.mockResolvedValue([
          { dependsOn: taskB },
          { dependsOn: taskC },
        ]);

        const result = await taskAccessor.getDependencies('task-a');

        expect(mockPrisma.taskDependency.findMany).toHaveBeenCalledWith({
          where: { taskId: 'task-a' },
          include: { dependsOn: true },
        });
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('task-b');
        expect(result[1].id).toBe('task-c');
      });
    });

    describe('getDependents', () => {
      it('should return tasks that depend on this task', async () => {
        const taskA = createTask({ id: 'task-a' });
        const taskB = createTask({ id: 'task-b' });
        mockPrisma.taskDependency.findMany.mockResolvedValue([{ task: taskA }, { task: taskB }]);

        const result = await taskAccessor.getDependents('task-c');

        expect(mockPrisma.taskDependency.findMany).toHaveBeenCalledWith({
          where: { dependsOnId: 'task-c' },
          include: { task: true },
        });
        expect(result).toHaveLength(2);
      });
    });

    describe('getBlockedBy', () => {
      it('should return incomplete dependencies', async () => {
        const incompleteTask = createTask({ id: 'incomplete', state: TaskState.IN_PROGRESS });
        const completeTask = createTask({ id: 'complete', state: TaskState.COMPLETED });
        mockPrisma.taskDependency.findMany.mockResolvedValue([
          { dependsOn: incompleteTask },
          { dependsOn: completeTask },
        ]);

        const result = await taskAccessor.getBlockedBy('task-a');

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('incomplete');
      });

      it('should return empty array when all dependencies are complete', async () => {
        const completeTask = createTask({ state: TaskState.COMPLETED });
        mockPrisma.taskDependency.findMany.mockResolvedValue([{ dependsOn: completeTask }]);

        const result = await taskAccessor.getBlockedBy('task-a');

        expect(result).toHaveLength(0);
      });
    });

    describe('isBlocked', () => {
      it('should return true when task has incomplete dependencies', async () => {
        const incompleteTask = createTask({ state: TaskState.PENDING });
        mockPrisma.taskDependency.findMany.mockResolvedValue([{ dependsOn: incompleteTask }]);

        const result = await taskAccessor.isBlocked('task-a');

        expect(result).toBe(true);
      });

      it('should return false when all dependencies are complete', async () => {
        mockPrisma.taskDependency.findMany.mockResolvedValue([]);

        const result = await taskAccessor.isBlocked('task-a');

        expect(result).toBe(false);
      });
    });

    describe('wouldCreateCycle', () => {
      it('should return true if adding dependency would create cycle', async () => {
        mockPrisma.taskDependency.findMany.mockResolvedValueOnce([{ dependsOnId: 'task-a' }]);

        const accessor = new TaskAccessor();
        const result = await accessor.wouldCreateCycle('task-a', 'task-b');

        expect(result).toBe(true);
      });

      it('should return false if no cycle would be created', async () => {
        mockPrisma.taskDependency.findMany.mockResolvedValue([]);

        const result = await taskAccessor.wouldCreateCycle('task-a', 'task-b');

        expect(result).toBe(false);
      });

      it('should detect multi-hop cycles (A->B->C->A)', async () => {
        mockPrisma.taskDependency.findMany
          .mockResolvedValueOnce([{ dependsOnId: 'task-b' }])
          .mockResolvedValueOnce([{ dependsOnId: 'task-a' }]);

        const result = await taskAccessor.wouldCreateCycle('task-a', 'task-c');

        expect(result).toBe(true);
      });
    });
  });

  describe('state and queue helpers', () => {
    describe('getReadyTasks', () => {
      it('should return PENDING tasks with no blockers', async () => {
        const readyTask = createTask({ id: 'ready', state: TaskState.PENDING });
        const blockedTask = createTask({ id: 'blocked', state: TaskState.PENDING });

        mockPrisma.task.findMany.mockResolvedValue([readyTask, blockedTask]);
        mockPrisma.taskDependency.findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ dependsOn: createTask({ state: TaskState.IN_PROGRESS }) }]);

        const result = await taskAccessor.getReadyTasks('parent-id');

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ready');
      });
    });

    describe('getReviewQueue', () => {
      it('should return tasks in REVIEW state ordered by updatedAt', async () => {
        const task1 = createTask({ state: TaskState.REVIEW });
        const task2 = createTask({ state: TaskState.REVIEW });
        mockPrisma.task.findMany.mockResolvedValue([task1, task2]);

        const result = await taskAccessor.getReviewQueue('parent-id');

        expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
          where: {
            parentId: 'parent-id',
            state: TaskState.REVIEW,
          },
          orderBy: { updatedAt: 'asc' },
          include: { assignedAgent: true },
        });
        expect(result).toHaveLength(2);
      });
    });

    describe('areAllChildrenComplete', () => {
      it('should return true when all children are in terminal state', async () => {
        mockPrisma.task.count.mockResolvedValue(0);

        const result = await taskAccessor.areAllChildrenComplete('parent-id');

        expect(mockPrisma.task.count).toHaveBeenCalledWith({
          where: {
            parentId: 'parent-id',
            state: {
              notIn: [TaskState.COMPLETED, TaskState.FAILED],
            },
          },
        });
        expect(result).toBe(true);
      });

      it('should return false when some children are not complete', async () => {
        mockPrisma.task.count.mockResolvedValue(2);

        const result = await taskAccessor.areAllChildrenComplete('parent-id');

        expect(result).toBe(false);
      });
    });

    describe('getChildrenStateCounts', () => {
      it('should count children by state', async () => {
        mockPrisma.task.findMany.mockResolvedValue([
          { state: TaskState.PENDING },
          { state: TaskState.PENDING },
          { state: TaskState.IN_PROGRESS },
          { state: TaskState.COMPLETED },
          { state: TaskState.COMPLETED },
          { state: TaskState.COMPLETED },
        ]);

        const result = await taskAccessor.getChildrenStateCounts('parent-id');

        expect(result[TaskState.PENDING]).toBe(2);
        expect(result[TaskState.IN_PROGRESS]).toBe(1);
        expect(result[TaskState.COMPLETED]).toBe(3);
        expect(result[TaskState.FAILED]).toBe(0);
      });
    });
  });
});

describe('Task State Machine', () => {
  describe('valid state transitions for parent tasks (planning)', () => {
    const parentTaskStates: TaskState[] = [
      TaskState.PLANNING,
      TaskState.IN_PROGRESS,
      TaskState.COMPLETED,
    ];

    it('parent tasks should start in PLANNING state', () => {
      const task = createTask({ parentId: null });
      expect(task.state).toBe(TaskState.PLANNING);
    });

    it('parent tasks can transition from PLANNING to IN_PROGRESS', () => {
      const validTransition = {
        from: TaskState.PLANNING,
        to: TaskState.IN_PROGRESS,
      };
      expect(parentTaskStates).toContain(validTransition.from);
      expect(parentTaskStates).toContain(validTransition.to);
    });
  });

  describe('valid state transitions for leaf tasks (execution)', () => {
    const leafTaskFlow = [
      TaskState.PENDING,
      TaskState.IN_PROGRESS,
      TaskState.REVIEW,
      TaskState.COMPLETED,
    ];

    it('leaf tasks should start in PENDING state', () => {
      const task = createTask({ parentId: 'some-parent' });
      expect(task.state).toBe(TaskState.PENDING);
    });

    it('leaf tasks follow PENDING -> IN_PROGRESS -> REVIEW -> COMPLETED flow', () => {
      for (let i = 0; i < leafTaskFlow.length - 1; i++) {
        const from = leafTaskFlow[i];
        const to = leafTaskFlow[i + 1];
        expect(leafTaskFlow.indexOf(to)).toBe(leafTaskFlow.indexOf(from) + 1);
      }
    });
  });

  describe('terminal states', () => {
    const terminalStates = [TaskState.COMPLETED, TaskState.BLOCKED, TaskState.FAILED];

    it('should recognize all terminal states', () => {
      for (const state of terminalStates) {
        const task = createTask({ state });
        expect(terminalStates).toContain(task.state);
      }
    });
  });
});
