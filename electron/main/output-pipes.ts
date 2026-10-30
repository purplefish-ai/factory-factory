interface OutputStreamLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Absorb every write error on stdout and stderr so console output can never
 * crash Electron main. The common case is a closed pipe (EPIPE) after the
 * process that launched the app exits; a closed terminal raises EIO instead.
 * Without a listener, the asynchronous `error` event becomes an uncaught
 * exception, and forwarded backend output would raise one per line. These
 * streams only carry diagnostics, so there is nothing to report a failure to.
 */
export function ignoreOutputStreamErrors(streams: OutputStreamLike[]): void {
  for (const stream of streams) {
    stream.on('error', () => {
      // Nothing useful can be written to a broken output stream.
    });
  }
}
