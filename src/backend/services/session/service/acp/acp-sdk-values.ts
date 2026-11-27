/**
 * The ACP SDK runtime values this module uses, from the SDK's `/unstable`
 * entrypoint (it keeps elicitation and native subagents).
 *
 * With `@/shared/acp-protocol/sdk-types` for types, this is the only file that
 * names an SDK entrypoint (`sdk-entrypoints-have-two-import-sites` in
 * `.dependency-cruiser.cjs`). Tests mock the package, and the mock reaches code
 * through this re-export.
 */
export {
  agent,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk/unstable';
