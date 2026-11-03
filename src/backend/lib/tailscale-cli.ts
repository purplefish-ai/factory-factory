/** Tailscale CLI helpers shared by `ff tailscale` and backend port sharing. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

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

export function parseTailscaleJson(raw: string, command: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Tailscale returned invalid JSON. Run "tailscale ${command} --json" to check its connection and permissions.`,
      { cause: error }
    );
  }
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

/** Whether a Serve or Funnel listener already uses `port`, including foreground sessions. */
export function isServePortConfigured(rawConfig: string, port: number): boolean {
  const parsed = serveConfigSchema
    .nullable()
    .safeParse(parseTailscaleJson(rawConfig, 'serve status'));
  if (!parsed.success) {
    throw new Error(
      'Invalid Tailscale Serve configuration. Check "tailscale serve status --json" and update the Tailscale CLI if needed.'
    );
  }
  return parsed.data !== null && hasPort(parsed.data, port);
}

export function assertServePortAvailable(rawConfig: string, port: number): void {
  if (isServePortConfigured(rawConfig, port)) {
    throw new Error(
      `Tailscale port ${port} already has a Serve or Funnel configuration. Choose another port with --https-port (for example, --https-port 8443).`
    );
  }
}

export async function readTailscale(
  args: string[],
  signal?: AbortSignal,
  command = 'tailscale'
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
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
