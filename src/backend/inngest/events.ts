export type Events = {
  /**
   * Triggered when a top-level task (formerly "Epic") is created.
   * Top-level tasks have parentId = null.
   */
  'task.top_level.created': {
    data: {
      taskId: string;
      title: string;
    };
  };
  /**
   * Triggered when a top-level task's state changes.
   */
  'task.top_level.updated': {
    data: {
      taskId: string;
      state: string;
    };
  };
  /**
   * Triggered when a subtask is created (task with a parent).
   */
  'task.created': {
    data: {
      taskId: string;
      parentId: string;
      title: string;
    };
  };
  'task.updated': {
    data: {
      taskId: string;
      state: string;
    };
  };
  'task.assigned': {
    data: {
      taskId: string;
      agentId: string;
    };
  };
  'agent.created': {
    data: {
      agentId: string;
      type: string;
    };
  };
  'agent.state.changed': {
    data: {
      agentId: string;
      previousState: string;
      newState: string;
    };
  };
  'agent.completed': {
    data: {
      agentId: string;
      taskId?: string;
      /** ID of the top-level task (formerly epicId) */
      topLevelTaskId?: string;
    };
  };
  'mail.sent': {
    data: {
      mailId: string;
      toAgentId?: string;
      isForHuman: boolean;
      subject: string;
    };
  };
  'supervisor.check': {
    data: {
      timestamp: number;
    };
  };
  'orchestrator.check': {
    data: {
      /** ID of the top-level task (formerly epicId) */
      topLevelTaskId?: string;
      timestamp: number;
    };
  };
  /**
   * Triggered to run a reconciliation cycle.
   * Can be triggered immediately after state changes or periodically via cron.
   */
  'reconcile.requested': {
    data: {
      /** Optional: specific task ID to reconcile */
      taskId?: string;
      /** Optional: specific agent ID to reconcile */
      agentId?: string;
      /** Source of the reconciliation request */
      source: 'cron' | 'event' | 'manual';
      timestamp: number;
    };
  };
};
