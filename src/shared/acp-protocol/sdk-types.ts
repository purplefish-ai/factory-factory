/**
 * The ACP SDK types this codebase uses, from the SDK's `/unstable` entrypoint.
 *
 * With `acp-sdk-values.ts` in the session capsule's `acp` module, this is the
 * only file that names an SDK entrypoint (`sdk-entrypoints-have-two-import-sites`
 * in `.dependency-cruiser.cjs`). Types only: `src/shared/` reaches the browser,
 * which must never load the SDK's Node runtime. The list is the inventory of
 * the unstable surface the code depends on; add a name here when code needs it.
 */
export type {
  CancelNotification,
  CompleteElicitationNotification,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationSchema,
  InitializeRequest,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
  Stream,
} from '@agentclientprotocol/sdk/unstable';
