import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InvalidArgumentError } from 'commander';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const statusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }).nullable().optional(),
});

type ServeConfig = {
  TCP?: Record<string, unknown> | null;
  Web?: Record<string, unknown> | null;
  AllowFunnel?: Record<string, boolean> | null;
  Foreground?: Record<string, ServeConfig> | null;
};
const serveConfigSchema: z.ZodType<ServeConfig> = z.object({
  TCP: z.record(z.string(), z.unknown()).nullish(),
  Web: z.record(z.string(), z.unknown()).nullish(),
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
  Foreground: z.lazy(() => z.record(z.string(), serveConfigSchema)).nullish(),
});

function parseJson(raw: string, command: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Tailscale returned invalid JSON. Run "tailscale ${command} --json" to check its connection and permissions.`,
      { cause: error }
    );
  }
}

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new InvalidArgumentError('Port must be an integer between 1 and 65535.');
  }
  return Number(value);
}

export function getTailscaleOrigin(rawStatus: string, port: number): string {
  const parsed = statusSchema.safeParse(parseJson(rawStatus, 'status'));
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
  const hostname = status.Self?.DNSName.replace(/\.$/, '');
  if (!(hostname && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(hostname))) {
    throw new Error(
      'Tailscale did not return a valid machine DNS name. Enable MagicDNS in your tailnet.'
    );
  }
  return `https://${hostname}${port === 443 ? '' : `:${port}`}`;
}

function hasPort(config: ServeConfig, port: number): boolean {
  return (
    Object.hasOwn(config.TCP ?? {}, String(port)) ||
    Object.keys(config.Web ?? {}).some((host) => host.endsWith(`:${port}`)) ||
    Object.entries(config.AllowFunnel ?? {}).some(
      ([host, enabled]) => enabled && host.endsWith(`:${port}`)
    ) ||
    Object.values(config.Foreground ?? {}).some((nested) => hasPort(nested, port))
  );
}

export function assertServePortAvailable(rawConfig: string, port: number): void {
  const parsed = serveConfigSchema.nullable().safeParse(parseJson(rawConfig, 'serve status'));
  if (!parsed.success) {
    throw new Error(
      'Invalid Tailscale Serve configuration. Check "tailscale serve status --json" and update the Tailscale CLI if needed.'
    );
  }
  const config = parsed.data;
  if (config && hasPort(config, port)) {
    throw new Error(
      `Tailscale port ${port} already has a Serve or Funnel configuration. Choose another port with --https-port (for example, --https-port 8443).`
    );
  }
}

export async function readTailscale(args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tailscale', args, {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    return stdout;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(
      `Could not run "tailscale ${args.join(' ')}". Install the Tailscale CLI, connect this machine, and check daemon permissions.`,
      { cause: error }
    );
  }
}

export async function discoverTailscale(port: number, signal?: AbortSignal): Promise<string> {
  const origin = getTailscaleOrigin(await readTailscale(['status', '--json'], signal), port);
  assertServePortAvailable(await readTailscale(['serve', 'status', '--json'], signal), port);
  return origin;
}
