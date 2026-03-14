import type { CodexModelEntry } from './adapter-state';
import { CodexRpcClient } from './codex-rpc-client';
import { loadModelCatalog } from './session-negotiation';

const MODEL_LOADER_CLIENT_INFO = {
  name: 'factory-factory-codex-model-catalog-loader',
  version: '0.1.0',
} as const;

/**
 * Reads the latest Codex model catalog directly from `codex app-server`.
 */
export async function fetchCodexModelCatalogFromAppServer(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexModelEntry[]> {
  const codex = new CodexRpcClient({
    cwd: options?.cwd ?? process.cwd(),
    env: options?.env ?? { ...process.env },
  });

  codex.start();
  try {
    await codex.request('initialize', {
      clientInfo: MODEL_LOADER_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });
    codex.notify('initialized');

    return await loadModelCatalog({ codex });
  } finally {
    await codex.stop();
  }
}
