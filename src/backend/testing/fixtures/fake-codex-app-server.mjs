#!/usr/bin/env node
// Synthetic app-server for testing the published ACP executable without inference.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const nativeId = '11111111-1111-4111-8111-111111111111';
const thread = {
  id: nativeId,
  cwd: process.cwd(),
  turns: [],
  historyMode: 'legacy',
  status: { type: 'idle' },
  source: 'cli',
  modelProvider: 'openai',
  createdAt: 0,
  updatedAt: 0,
  preview: 'Synthetic conversation',
};
const model = {
  id: 'contract-model',
  model: 'contract-model',
  displayName: 'Contract model',
  description: 'Synthetic model',
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
  inputModalities: ['text', 'image'],
  supportsPersonality: false,
};
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (process.env.FF_ACP_PROBE_LOG) {
    appendFileSync(process.env.FF_ACP_PROBE_LOG, `${line}\n`);
  }
  if (!Object.hasOwn(request, 'id')) {
    return;
  }
  let result = {};
  switch (request.method) {
    case 'initialize':
      result = { userAgent: 'synthetic', codexHome: process.env.CODEX_HOME };
      break;
    case 'account/read':
      result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
      break;
    case 'config/read':
      result = { config: {}, layers: [] };
      break;
    case 'model/list':
      result = { data: [model], nextCursor: null };
      break;
    case 'skills/list':
      result = { data: [] };
      break;
    case 'thread/start':
      result = {
        thread: request.params.ephemeral ? { ...thread, id: 'title-thread' } : thread,
        model: model.id,
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
        reasoningEffort: 'medium',
        serviceTier: null,
      };
      break;
    case 'thread/resume':
      if (request.params.threadId !== nativeId) {
        send({ id: request.id, error: { code: -32_602, message: 'Unknown synthetic thread' } });
        return;
      }
      result = {
        thread,
        model: model.id,
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: 'medium',
        materialized: true,
        collaborationMode: 'default',
      };
      break;
    case 'thread/read':
      result = { thread };
      break;
    case 'thread/goal/get':
      result = { goal: null };
      break;
    case 'mcpServerStatus/list':
      result = { data: [], nextCursor: null };
      break;
    case 'turn/start': {
      const turn = { id: `turn-${request.id}`, status: 'inProgress', items: [], error: null };
      const threadId = request.params.threadId;
      send({ id: request.id, result: { turn } });
      setTimeout(() => {
        const targetedStopContract = request.params.input?.some(
          (input) => input.text === 'Synthetic targeted stop contract'
        );
        if (targetedStopContract) {
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId: turn.id,
              item: {
                id: 'child-activity',
                type: 'subAgentActivity',
                kind: 'started',
                agentThreadId: '22222222-2222-4222-8222-222222222222',
                agentPath: '/root/Worker',
              },
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: '22222222-2222-4222-8222-222222222222',
              turn: { id: 'child-turn', status: 'completed', items: [], error: null },
            },
          });
        }
        send({
          method: 'item/started',
          params: {
            threadId,
            turnId: turn.id,
            item: { id: 'message', type: 'agentMessage', text: '' },
          },
        });
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId: turn.id, itemId: 'message', delta: 'Synthetic response' },
        });
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId: turn.id,
            item: { id: 'message', type: 'agentMessage', text: 'Synthetic response' },
          },
        });
        send({
          method: 'turn/completed',
          params: { threadId, turn: { ...turn, status: 'completed' } },
        });
      }, 5);
      return;
    }
  }
  send({ id: request.id, result });
});
