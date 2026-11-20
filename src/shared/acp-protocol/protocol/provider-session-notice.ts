import { z } from 'zod';

export const ProviderSessionNoticeSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  provider: z.enum(['CLAUDE', 'CODEX']).optional(),
  severity: z.enum(['info', 'warning']),
  category: z.string().optional(),
  title: z.string().trim().min(1),
  details: z.string().optional(),
  reconnect: z.enum(['retrying', 'recovered', 'ended']).optional(),
});

export type ProviderSessionNotice = z.infer<typeof ProviderSessionNoticeSchema>;

export function readCodexReconnectTitle(title: string): { progress?: string } | null {
  if (/^Reconnecting(?:\.\.\.|…) waiting for network$/.test(title)) {
    return {};
  }
  const match = /^Reconnecting(?:\.\.\.|…)? ([1-9]\d{0,5})\/([1-9]\d{0,5})$/.exec(title);
  return match && Number(match[1]) <= Number(match[2])
    ? { progress: `Attempt ${match[1]} of ${match[2]}` }
    : null;
}
