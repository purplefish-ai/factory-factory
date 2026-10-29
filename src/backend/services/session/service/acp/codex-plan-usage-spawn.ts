import { getOwnedCodexCommand } from '@/backend/lib/owned-codex-command';
import type { SpawnCommand } from './acp-runtime-spawn';

export function resolveCodexPlanUsageSpawnCommand(): SpawnCommand {
  return { ...getOwnedCodexCommand(['app-server']), commandLabel: 'codex app-server' };
}
