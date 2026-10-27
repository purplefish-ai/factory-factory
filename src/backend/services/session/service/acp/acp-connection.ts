import {
  client,
  type CancelNotification,
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeRequest,
  type LoadSessionRequest,
  methods,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionModeRequest,
  type Stream,
} from '@agentclientprotocol/sdk/unstable';

export type AcpClientCallbacks = {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  createElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  completeElicitation?(params: CompleteElicitationNotification): Promise<void>;
  extNotification?(method: string, params: unknown): Promise<void>;
};

// Keep SDK app registration and peer-context calls at the transport boundary.
// The unstable v1 entrypoint preserves elicitation and native subagent support.
export function createAcpConnection(handler: AcpClientCallbacks, stream: Stream) {
  const app = client()
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      handler.requestPermission(params)
    )
    .onNotification(methods.client.session.update, ({ params }) => handler.sessionUpdate(params));
  const createElicitation = handler.createElicitation?.bind(handler);
  if (createElicitation) {
    app.onRequest(methods.client.elicitation.create, ({ params }) => createElicitation(params));
  }
  const completeElicitation = handler.completeElicitation?.bind(handler);
  if (completeElicitation) {
    app.onNotification(methods.client.elicitation.complete, ({ params }) =>
      completeElicitation(params)
    );
  }
  const extNotification = handler.extNotification?.bind(handler);
  if (extNotification) {
    app.onNotification('*', ({ method, params }) => extNotification(method, params));
  }
  const connection = app.connect(stream);
  const peer = connection.agent;
  return {
    initialize: (params: InitializeRequest) => peer.request(methods.agent.initialize, params),
    newSession: (params: NewSessionRequest) => peer.request(methods.agent.session.new, params),
    loadSession: (params: LoadSessionRequest) => peer.request(methods.agent.session.load, params),
    prompt: (params: PromptRequest) => peer.request(methods.agent.session.prompt, params),
    cancel: (params: CancelNotification) => peer.notify(methods.agent.session.cancel, params),
    setSessionConfigOption: (params: SetSessionConfigOptionRequest) =>
      peer.request(methods.agent.session.setConfigOption, params),
    setSessionMode: (params: SetSessionModeRequest) =>
      peer.request(methods.agent.session.setMode, params),
    extMethod: (method: string, params: Record<string, unknown>) => peer.request(method, params),
    close: () => connection.close(),
  };
}

export type AcpConnection = ReturnType<typeof createAcpConnection>;
