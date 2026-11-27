import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifySetupTerminal } from './packed-setup-terminal.mjs';

const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create') }),
  z.object({ type: z.literal('input'), data: z.string() }),
]);

/**
 * The setup terminal as the packed check sees it, with the output ordering
 * fixed by the test. `drops-output-before-exit` loses what a shell prints in
 * the same input line that exits it, while the echo of that line still
 * arrives: the ordering that failed CI run 45865015699. `exits-early` ends the
 * shell with status 0 before it prints anything.
 */
class FakeSetupTerminal extends EventEmitter {
  constructor(private readonly shell: 'drops-output-before-exit' | 'exits-early') {
    super();
    setImmediate(() => this.emit('open'));
  }

  send(raw: string): void {
    const message = inputSchema.parse(JSON.parse(raw));
    if (message.type === 'create') {
      this.deliver({ type: 'created' });
      return;
    }
    const line = message.data;
    this.deliver({ type: 'output', data: `${line}\n` });
    if (this.shell === 'exits-early') {
      this.deliver({ type: 'exit', exitCode: 0 });
      return;
    }
    const prints =
      line.includes("printf 'packed-%s\\n' ready") || line.includes('echo packed-^ready');
    if (line.includes('exit 0')) {
      this.deliver({ type: 'exit', exitCode: 0 });
    } else if (prints) {
      this.deliver({ type: 'output', data: 'packed-' });
      this.deliver({ type: 'output', data: 'ready\r\n' });
    }
  }

  private deliver(message: Record<string, unknown>): void {
    setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(message))));
  }
}

describe('verifySetupTerminal', () => {
  it.each([{ windows: false }, { windows: true }])(
    'does not depend on output printed just before the shell exits (windows: $windows)',
    async ({ windows }) => {
      const socket = new FakeSetupTerminal('drops-output-before-exit');
      await expect(verifySetupTerminal(socket, { z, windows })).resolves.toBeUndefined();
    }
  );

  it('fails when the shell exits before printing the marker', async () => {
    const socket = new FakeSetupTerminal('exits-early');
    await expect(verifySetupTerminal(socket, { z, windows: false })).rejects.toThrow(
      'Setup terminal: {"type":"exit","exitCode":0}'
    );
  });
});
