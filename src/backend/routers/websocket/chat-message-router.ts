import type { ApplicationServices } from '@/backend/app-context';
import type {
  SessionCommandConfigService,
  SessionCommandFactories,
  SessionCommandHandler,
  SessionCommandOutcome,
  SessionExecutionCommandServices,
  SessionPermissionCommandService,
  SessionDispatchService,
  SessionLoadService,
  SessionEventBus,
  SessionFileLogger,
} from '@/backend/services/session';
import type { ChatMessageInput } from '@/shared/websocket';
import { executeSessionLoad } from './chat-load-adapter';

export interface ChatMessageRouterServices {
  factories: SessionCommandFactories;
  execution: SessionExecutionCommandServices;
  runtime: Parameters<SessionCommandFactories['createUserInputHandler']>[0]['acpRuntimeManager'];
  config: SessionCommandConfigService;
  permission: SessionPermissionCommandService;
  prompt: Parameters<SessionCommandFactories['createUserInputHandler']>[0]['sessionService'];
  startup: Parameters<SessionCommandFactories['createStartHandler']>[0]['startupService'];
  dispatch: Pick<
    SessionDispatchService,
    'tryDispatchNextMessage' | 'setManualDispatchResume' | 'resetDispatchState'
  >;
  load: Pick<SessionLoadService, 'prepareLoad' | 'captureReplay' | 'completeLoad'>;
  eventBus: Pick<SessionEventBus, 'publishToSession'>;
  fileLogger: Pick<SessionFileLogger, 'log'>;
}

type ChatCommandRegistry = {
  [K in ChatMessageInput['type']]: SessionCommandHandler<Extract<ChatMessageInput, { type: K }>>;
};

/** Compose application commands at the WebSocket boundary; no command receives a socket. */
export function createChatCommandRegistry(
  services: ChatMessageRouterServices
): ChatCommandRegistry {
  const {
    createPermissionResponseHandler,
    createQueueMessageHandler,
    createRemoveQueuedMessageHandler,
    createResumeQueuedMessagesHandler,
    createSetConfigOptionHandler,
    createSetModelHandler,
    createSetThinkingBudgetHandler,
    createStartHandler,
    createStopHandler,
    createUserInputHandler,
  } = services.factories;
  const dispatch = (sessionId: string) => services.dispatch.tryDispatchNextMessage(sessionId);
  const registry: ChatCommandRegistry = {
    start: createStartHandler({
      startupService: services.startup,
      lifecycle: services.execution.lifecycle,
      domain: services.execution.domain,
      backgroundDelivery: services.execution.backgroundDelivery,
    }),
    user_input: createUserInputHandler({
      acpRuntimeManager: services.runtime,
      sessionService: services.prompt,
      backgroundDelivery: services.execution.backgroundDelivery,
    }),
    queue_message: createQueueMessageHandler({
      domain: services.execution.domain,
      backgroundDelivery: services.execution.backgroundDelivery,
      tryDispatchNextMessage: dispatch,
    }),
    remove_queued_message: createRemoveQueuedMessageHandler({ domain: services.execution.domain }),
    resume_queued_messages: createResumeQueuedMessagesHandler({
      backgroundDelivery: services.execution.backgroundDelivery,
      tryDispatchNextMessage: dispatch,
      setManualDispatchResume: (sessionId, resumed) =>
        services.dispatch.setManualDispatchResume(sessionId, resumed),
    }),
    stop: createStopHandler({
      lifecycle: services.execution.lifecycle,
      clearPendingRequest: (sessionId) => services.execution.clearPendingRequest(sessionId),
      resetDispatchState: (sessionId) => services.dispatch.resetDispatchState(sessionId),
      tryDispatchNextMessage: dispatch,
    }),
    load_session: ({ sessionId }, message) =>
      executeSessionLoad(
        { sessionId, loadRequestId: message.loadRequestId },
        {
          loadService: services.load,
          eventBus: services.eventBus,
          fileLogger: services.fileLogger,
        }
      ),
    permission_response: createPermissionResponseHandler({
      sessionPermissionService: services.permission,
    }),
    set_model: createSetModelHandler({ sessionConfigService: services.config }),
    set_thinking_budget: createSetThinkingBudgetHandler({ sessionConfigService: services.config }),
    set_config_option: createSetConfigOptionHandler({ sessionConfigService: services.config }),
  };
  return registry;
}

export function createChatMessageRouter(services: ChatMessageRouterServices) {
  const registry = createChatCommandRegistry(services);
  return {
    async handleMessage(
      sessionId: string | null,
      workingDir: string,
      message: ChatMessageInput
    ): Promise<SessionCommandOutcome> {
      if (!sessionId) {
        return { replies: [{ type: 'error', error: { kind: 'no_session' } }] };
      }
      const context = { sessionId, workingDir };
      switch (message.type) {
        case 'start':
          return await registry.start(context, message);
        case 'stop':
          return await registry.stop(context, message);
        case 'user_input':
          return await registry.user_input(context, message);
        case 'queue_message':
          return await registry.queue_message(context, message);
        case 'remove_queued_message':
          return await registry.remove_queued_message(context, message);
        case 'resume_queued_messages':
          return await registry.resume_queued_messages(context, message);
        case 'load_session':
          return await registry.load_session(context, message);
        case 'set_model':
          return await registry.set_model(context, message);
        case 'set_config_option':
          return await registry.set_config_option(context, message);
        case 'set_thinking_budget':
          return await registry.set_thinking_budget(context, message);
        case 'permission_response':
          return await registry.permission_response(context, message);
        default: {
          const unhandled: never = message;
          throw new Error(`Unsupported session command: ${unhandled}`);
        }
      }
    },
  };
}

/** Adapt application capabilities, retaining the established startup option filter. */
export function createChatMessageRouterForApplication(
  services: Pick<
    ApplicationServices,
    | 'sessionCommandFactories'
    | 'sessionDomainService'
    | 'sessionLifecycleService'
    | 'sessionBackgroundDeliveryService'
    | 'chatEventForwarderService'
    | 'acpRuntimeManager'
    | 'sessionConfigService'
    | 'sessionPermissionService'
    | 'sessionService'
    | 'sessionDispatchService'
    | 'sessionLoadService'
    | 'sessionEventBus'
    | 'sessionFileLogger'
  >
) {
  return createChatMessageRouter({
    factories: services.sessionCommandFactories,
    execution: {
      domain: services.sessionDomainService,
      lifecycle: services.sessionLifecycleService,
      backgroundDelivery: services.sessionBackgroundDeliveryService,
      clearPendingRequest: (sessionId) =>
        services.chatEventForwarderService.clearPendingRequest(sessionId),
    },
    runtime: services.acpRuntimeManager,
    config: services.sessionConfigService,
    permission: services.sessionPermissionService,
    prompt: services.sessionService,
    startup: {
      getSessionClient: (sessionId) => services.sessionLifecycleService.getSessionClient(sessionId),
      getOrCreateSessionClient: (sessionId, options) =>
        services.sessionLifecycleService.getOrCreateSessionClient(sessionId, {
          resumePolicy: options.resumePolicy,
          thinkingEnabled: options.thinkingEnabled,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
        }),
    },
    dispatch: services.sessionDispatchService,
    load: services.sessionLoadService,
    eventBus: services.sessionEventBus,
    fileLogger: services.sessionFileLogger,
  });
}
