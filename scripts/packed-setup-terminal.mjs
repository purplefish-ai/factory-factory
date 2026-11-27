// Drives the packed setup terminal over a WebSocket. `z` is the installed
// package's Zod, so the check uses the dependencies it ships.
//
// The shell is asked to exit only after its output has been seen. node-pty
// reports a PTY exit once its reader closes, or 200 ms after the process exits
// if the reader has not closed by then, and in that case it discards output
// it has not read yet. Output printed in the same line as `exit` can therefore
// be lost on a busy machine, and the check must not depend on it.
const MARKER = 'packed-ready';

export function verifySetupTerminal(socket, { z, windows, timeoutMs = 15_000 }) {
  const terminalMessage = z.discriminatedUnion('type', [
    z.object({ type: z.literal('created') }),
    z.object({ type: z.literal('output'), data: z.string() }),
    z.object({ type: z.literal('error'), message: z.string() }),
    z.object({ type: z.literal('exit'), exitCode: z.number() }),
  ]);
  const input = (data) => socket.send(JSON.stringify({ type: 'input', data }));
  return new Promise((done, fail) => {
    let output = '';
    let exitRequested = false;
    socket.on('open', () => socket.send(JSON.stringify({ type: 'create' })));
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('Setup terminal disconnected')));
    socket.on('message', (data) => {
      try {
        const message = terminalMessage.parse(JSON.parse(data.toString()));
        if (message.type === 'created') {
          // The marker never appears in the echoed shell command.
          input(windows ? 'echo packed-^ready\r' : "printf 'packed-%s\\n' ready\r");
        } else if (message.type === 'output') {
          output = (output + message.data).slice(-8192);
          if (!exitRequested && output.includes(MARKER)) {
            exitRequested = true;
            input('exit 0\r');
          }
        } else if (message.type === 'exit' && message.exitCode === 0 && exitRequested) {
          done();
        } else {
          fail(new Error(`Setup terminal: ${JSON.stringify(message)}`));
        }
      } catch (error) {
        fail(error);
      }
    });
    const timer = setTimeout(() => fail(new Error('Setup terminal timed out')), timeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
}
