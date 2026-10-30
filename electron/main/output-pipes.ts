interface OutputStreamLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Keep console output from crashing Electron main when stdout or stderr is a
 * closed pipe (for example, when the app was launched by a process that has
 * since exited). Without a listener, the asynchronous EPIPE `error` event
 * becomes an uncaught exception. Backend output is forwarded line by line, so
 * a closed pipe would otherwise raise one fatal error per line.
 */
export function ignoreOutputStreamErrors(streams: OutputStreamLike[]): void {
  for (const stream of streams) {
    stream.on('error', () => {
      // Nothing useful can be written to a broken output stream.
    });
  }
}
