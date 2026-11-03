import { InvalidArgumentError } from 'commander';
import { z } from 'zod';
import {
  assertServePortAvailable,
  parseTailscaleJson,
  readTailscale,
} from '@/backend/lib/tailscale-cli';

const statusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }).nullable().optional(),
});

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new InvalidArgumentError('Port must be an integer between 1 and 65535.');
  }
  return Number(value);
}

export function getTailscaleOrigin(rawStatus: string, port: number): string {
  const parsed = statusSchema.safeParse(parseTailscaleJson(rawStatus, 'status'));
  if (!parsed.success) {
    throw new Error(
      'Invalid Tailscale status. Check "tailscale status --json" and connect this machine.'
    );
  }
  const status = parsed.data;
  if (status.BackendState !== 'Running') {
    throw new Error(
      `Tailscale is not running (${status.BackendState}). Connect the machine with Tailscale or run "tailscale up" to login.`
    );
  }
  const hostname = status.Self?.DNSName.replace(/\.$/, '').toLowerCase();
  if (!(hostname && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(hostname))) {
    throw new Error(
      'Tailscale did not return a valid machine DNS name. Enable MagicDNS in your tailnet.'
    );
  }
  return `https://${hostname}${port === 443 ? '' : `:${port}`}`;
}

export async function discoverTailscale(port: number, signal?: AbortSignal): Promise<string> {
  const origin = getTailscaleOrigin(await readTailscale(['status', '--json'], signal), port);
  assertServePortAvailable(await readTailscale(['serve', 'status', '--json'], signal), port);
  return origin;
}
