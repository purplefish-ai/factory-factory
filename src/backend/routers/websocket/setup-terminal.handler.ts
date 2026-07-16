/**
 * Setup Terminal WebSocket Handler
 *
 * Lightweight terminal for pre-project setup tasks (e.g., `gh auth login`).
 * Unlike workspace terminals, these are not persisted in the database and
 * are destroyed when the WebSocket connection closes.
 */

import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { toError } from '@/backend/lib/error-utils';
import { sendStreamOutput } from '@/backend/lib/websocket-send';
import {
  type SetupTerminalMessageInput,
  SetupTerminalMessageSchema,
} from '@/backend/schemas/websocket';
import { parseWebSocketMessage, sendJsonError } from './message-utils';
import { createWebSocketUpgradeHandler } from './upgrade-utils';

const require = createRequire(import.meta.url);

function getNodePty(): typeof import('node-pty') {
  return require('node-pty');
}

interface SetupTerminalState {
  pty: IPty | null;
}

type SetupTerminalLogger = ReturnType<AppContext['services']['createLogger']>;
type SetupTerminalConfigService = AppContext['services']['configService'];

function handleCreate(
  ws: WebSocket,
  message: Extract<SetupTerminalMessageInput, { type: 'create' }>,
  state: SetupTerminalState,
  logger: SetupTerminalLogger,
  configService: SetupTerminalConfigService
): void {
  if (state.pty) {
    ws.send(JSON.stringify({ type: 'error', message: 'Terminal already exists' }));
    return;
  }

  const cols = message.cols ?? 80;
  const rows = message.rows ?? 24;
  const cwd = homedir() || tmpdir();
  const shellPath = configService.getShellPath();

  logger.info('Creating setup terminal', { cwd, shell: shellPath, cols, rows });

  const nodePty = getNodePty();
  state.pty = nodePty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...configService.getChildProcessEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  state.pty.onData((output: string) => {
    sendStreamOutput(
      ws,
      JSON.stringify({ type: 'output', data: output }),
      logger,
      'setup terminal output'
    );
  });

  state.pty.onExit(({ exitCode }: { exitCode: number }) => {
    logger.info('Setup terminal exited', { exitCode });
    if (ws.readyState === WS_READY_STATE.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    state.pty = null;
  });

  ws.send(JSON.stringify({ type: 'created' }));
}

function handleInput(
  message: Extract<SetupTerminalMessageInput, { type: 'input' }>,
  state: SetupTerminalState
): void {
  if (state.pty) {
    state.pty.write(message.data);
  }
}

function handleResize(
  message: Extract<SetupTerminalMessageInput, { type: 'resize' }>,
  state: SetupTerminalState
): void {
  if (state.pty) {
    state.pty.resize(message.cols, message.rows);
  }
}

export function createSetupTerminalUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('setup-terminal-handler');
  const { configService } = appContext.services;

  return createWebSocketUpgradeHandler({
    connectionName: 'setup terminal',
    configService,
    logger,
    onOpen: (ws) => {
      logger.info('Setup terminal WebSocket connected');

      const state: SetupTerminalState = { pty: null };

      ws.on('message', (data) => {
        try {
          const message = parseWebSocketMessage(
            SetupTerminalMessageSchema,
            data,
            logger,
            'setup terminal message'
          );
          if (!message) {
            sendJsonError(ws, 'Invalid message format');
            return;
          }

          switch (message.type) {
            case 'create':
              handleCreate(ws, message, state, logger, configService);
              break;
            case 'input':
              handleInput(message, state);
              break;
            case 'resize':
              handleResize(message, state);
              break;
          }
        } catch (error) {
          const err = toError(error);
          logger.error('Error in setup terminal', err);
          sendJsonError(ws, err.message);
        }
      });

      ws.on('close', () => {
        logger.info('Setup terminal WebSocket closed');
        if (state.pty) {
          state.pty.kill();
          state.pty = null;
        }
      });

      ws.on('error', (error) => {
        logger.error('Setup terminal WebSocket error', error);
      });
    },
  });
}
