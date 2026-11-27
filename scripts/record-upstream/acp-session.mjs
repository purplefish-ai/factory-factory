// Drives a bundled ACP adapter with the SDK client and keeps every JSON-RPC
// line in both directions, in order.
import { spawn } from 'node:child_process';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { lineSplitter, stopChild, trackChild } from './environment.mjs';

const PROMPT_TIMEOUT_MS = 180_000;

// The initialize request Factory Factory sends (acp-client-factory.ts).
export const FACTORY_FACTORY_INITIALIZE = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    session: { compaction: {} },
    subagents: {},
    elicitation: { form: {}, url: {} },
    _meta: {
      terminal_output_delta: true,
      jetbrains: {
        air: {
          version: 1,
          capabilities: ['asyncTasks', 'sessionFailure', 'loadReplayEnd'],
        },
      },
    },
  },
  clientInfo: { name: 'factory-factory', title: 'Factory Factory', version: '1.2.0' },
};

function withTimeout(promise, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), PROMPT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Starts the adapter at `entrypoint` with `env` in `cwd`. Permission requests
 * are answered with the first `allow_once` option; `onUpdate` sees every
 * session update so a scenario can cancel part-way.
 */
export function startAcpSession({ entrypoint, env, cwd }) {
  const records = [];
  const permissions = [];
  let onUpdate = () => undefined;
  const child = trackChild(
    spawn(process.execPath, [entrypoint], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  );
  // Adapter diagnostics are not part of the protocol and may carry local paths.
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('close', resolve));
  const record = (dir) =>
    lineSplitter((line) => {
      records.push({ dir, line });
    });
  const fromAgent = record('agent->client');
  const toAgent = record('client->agent');
  const input = new ReadableStream({
    start(controller) {
      child.stdout.on('data', (chunk) => {
        fromAgent(chunk);
        controller.enqueue(new Uint8Array(chunk));
      });
      child.stdout.once('end', () => controller.close());
    },
  });
  const output = new WritableStream({
    write(chunk) {
      toAgent(Buffer.from(chunk));
      return new Promise((resolve, reject) =>
        child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()))
      );
    },
    close() {
      child.stdin.end();
    },
  });
  child.stdin.on('error', () => undefined);

  const app = client()
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      const option = params.options.find((candidate) => candidate.kind === 'allow_once');
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    })
    .onRequest(methods.client.elicitation.create, () => ({ action: 'decline' }))
    .onNotification(methods.client.session.update, ({ params }) => onUpdate(params));
  const connection = app.connect(ndJsonStream(output, input));
  const agent = connection.agent;

  return {
    records,
    permissions,
    initialize: () =>
      withTimeout(
        agent.request(methods.agent.initialize, FACTORY_FACTORY_INITIALIZE),
        'initialize'
      ),
    newSession: (params) =>
      withTimeout(agent.request(methods.agent.session.new, params), 'session/new'),
    setMode: (params) =>
      withTimeout(agent.request(methods.agent.session.setMode, params), 'session/set_mode'),
    prompt: (params, updateHandler = () => undefined) => {
      onUpdate = updateHandler;
      return withTimeout(agent.request(methods.agent.session.prompt, params), 'session/prompt');
    },
    cancel: (params) => agent.notify(methods.agent.session.cancel, params),
    stop: () => stopChild(child, exited, 10_000),
  };
}
