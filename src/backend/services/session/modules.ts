/**
 * The module map of the session capsule. Data only: `pnpm check:service-registry`
 * compares it with the imports in `service/`, and `pnpm metrics:agents` counts
 * `sessionModuleCycles`. The application does not read it.
 *
 * A module is a directory directly under `service/`; the files directly under
 * `service/` form the module `root`. `dependsOn` lists, sorted, every sibling
 * module that a production file in the module imports, re-exports or imports
 * types from. Tests and test support do not count.
 */
export const sessionModules: Record<
  string,
  { dependsOn: readonly string[]; description: string; sealed?: boolean }
> = {
  acp: {
    dependsOn: [],
    description:
      'Runs the ACP adapter processes for Claude Code and Codex (spawn, handshake, prompts, steering, stops, permission and elicitation requests) and the disposable probes for model catalogs, launch options and plan usage.',
  },
  archive: {
    dependsOn: [],
    description: 'Writes and reads the transcript file kept for a session after it is closed.',
  },
  chat: {
    dependsOn: ['config', 'data', 'delivery', 'dispatch', 'lifecycle', 'root', 'store', 'voice'],
    description:
      'Handles chat commands from clients (queue, steer, stop, model and config changes, permission replies), validates and converts attachments, prepares session loads and forwards pending requests and workspace notifications.',
  },
  composition: {
    dependsOn: [
      'acp',
      'archive',
      'chat',
      'config',
      'data',
      'delivery',
      'dispatch',
      'event-agent',
      'events',
      'lifecycle',
      'prompt',
      'providers',
      'root',
      'store',
    ],
    description:
      "Constructs the capsule's service singletons and wires them to each other: the capsule's composition root.",
  },
  config: {
    dependsOn: ['acp', 'data', 'providers', 'root'],
    description:
      "Owns a session's provider configuration (model, mode, reasoning, access): applies it at startup, serializes live edits, persists snapshots and serves launch options.",
  },
  data: {
    dependsOn: ['acp', 'archive', 'root', 'store'],
    description:
      'Reads and writes session records through the capsule accessors, resolves session providers and launch settings, and loads Claude and Codex history files into transcripts.',
  },
  delivery: {
    dependsOn: ['data', 'root'],
    description:
      'Delivers PR updates and workspace mail into sessions as background prompts, with receipts and failure reasons, and schedules PR discovery after a turn.',
  },
  dispatch: {
    dependsOn: ['acp', 'chat', 'config', 'data', 'delivery', 'event-agent', 'root', 'voice'],
    description:
      "Runs a session's message queue: claims, batches and sends queued messages with retries, queued steering and mail wakes, and the first turn of event-launched sessions.",
  },
  'event-agent': {
    dependsOn: ['acp', 'data'],
    description:
      'Holds the durable authority over sessions launched by event automations: initial-delivery permits, startup guards and evidence deadlines.',
  },
  events: {
    dependsOn: ['acp', 'config', 'logging', 'root', 'store'],
    description:
      'Applies ACP session updates to the transcript and runtime state, including tool timeouts, thought chunks, subagent updates and the queue of permission requests.',
  },
  inference: {
    dependsOn: ['acp'],
    description:
      'Runs one structured inference call in a disposable provider process, with no session, tools or repository.',
  },
  lifecycle: {
    dependsOn: [
      'acp',
      'archive',
      'config',
      'data',
      'delivery',
      'event-agent',
      'events',
      'logging',
      'root',
      'store',
    ],
    description:
      'Starts, stops, retries and tears down session runtimes: the lifecycle gate and scope, runtime exit, workflow finalization, provider identity and the lifecycle event record.',
  },
  logging: {
    dependsOn: [],
    description: 'Writes per-session debug logs of WebSocket events and ACP traces to files.',
  },
  metadata: {
    dependsOn: ['inference'],
    description:
      "Generates a workspace's title, branch name and summaries from its conversation with one disposable inference call.",
  },
  prompt: {
    dependsOn: ['acp', 'delivery', 'event-agent', 'events', 'lifecycle', 'root'],
    description:
      "Sends a prompt turn to a session's running ACP runtime under the turn limit and records its completion; builds the child-workspace context text.",
  },
  providers: {
    dependsOn: ['acp'],
    description:
      'Caches provider model catalogs and plan usage behind services whose fetchers are injected.',
  },
  root: {
    dependsOn: ['acp', 'composition', 'inference', 'store'],
    description:
      'Files not yet in a module: the session domain service over store, the session event bus, bridge types, the interceptor bridge, error messages and the agent event classifier.',
  },
  store: {
    dependsOn: ['logging', 'root'],
    description:
      "Holds each session's in-memory transcript, queue and runtime state and publishes snapshots and deltas; also caches slash commands read from disk.",
  },
  voice: {
    dependsOn: ['root'],
    description: 'Narrates session output aloud in voice mode through Deepgram text-to-speech.',
  },
};

/** Pairs that import each other today. May only shrink. */
export const sessionModuleCycles: readonly (readonly [string, string])[] = [
  ['chat', 'dispatch'],
  ['composition', 'root'],
  ['root', 'store'],
];
