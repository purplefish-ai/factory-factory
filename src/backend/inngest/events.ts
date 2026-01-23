export type Events = {
  'epic.created': {
    data: {
      epicId: string;
      linearIssueId: string;
      title: string;
    };
  };
  'epic.updated': {
    data: {
      epicId: string;
      state: string;
    };
  };
  'task.created': {
    data: {
      taskId: string;
      epicId: string;
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
      epicId?: string;
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
      epicId?: string;
      timestamp: number;
    };
  };
};
