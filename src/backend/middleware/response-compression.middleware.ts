import {
  type BrotliCompress,
  constants,
  createBrotliCompress,
  createGzip,
  type Gzip,
} from 'node:zlib';
import type { Request, RequestHandler, Response } from 'express';
import { type ContentEncoding, selectContentEncoding } from './content-encoding';

/**
 * A complete body smaller than this is sent as is: it fits in one packet over
 * Tailscale's 1280-byte MTU either way, so compressing it saves no round trip.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

// Fast levels: on a 100 KB JSON body each takes about 1 ms and reaches about
// 30 KB; the next levels up take half as long again for 1-5% fewer bytes.
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 4;

const COMPRESSIBLE_TYPE = /^application\/jsonl?\s*(?:;|$)/i;

type Callback = (error?: Error | null) => void;
type Compressor = BrotliCompress | Gzip;

/** One `write` or `end` call with its optional arguments resolved. */
interface Chunk {
  /** `undefined` for an `end` without data. */
  data: unknown;
  encoding: BufferEncoding | undefined;
  done: Callback | undefined;
}

type State =
  | { kind: 'undecided' }
  | { kind: 'identity' }
  | { kind: 'buffering'; encoding: ContentEncoding; chunks: Buffer[]; size: number }
  | { kind: 'compressing'; encoding: ContentEncoding; compressor: Compressor };

function isCallback(value: unknown): value is Callback {
  return typeof value === 'function';
}

function writeArguments(
  data: unknown,
  encodingOrCallback: BufferEncoding | Callback | undefined,
  callback: Callback | undefined
): Chunk {
  return isCallback(encodingOrCallback)
    ? { data, encoding: undefined, done: encodingOrCallback }
    : { data, encoding: encodingOrCallback, done: callback };
}

function endArguments(
  dataOrCallback: unknown,
  encodingOrCallback: BufferEncoding | Callback | undefined,
  callback: Callback | undefined
): Chunk {
  if (isCallback(dataOrCallback)) {
    return { data: undefined, encoding: undefined, done: dataOrCallback };
  }
  // `end(null)` ends without data, as it does on a plain response.
  return writeArguments(dataOrCallback ?? undefined, encodingOrCallback, callback);
}

function toBuffer({ data, encoding }: Chunk): Buffer | null {
  if (data === undefined) {
    return null;
  }
  if (typeof data === 'string') {
    return Buffer.from(data, encoding);
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('The "chunk" argument must be a string, Buffer or Uint8Array');
}

function createCompressor(encoding: ContentEncoding): Compressor {
  if (encoding === 'br') {
    return createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      },
    });
  }
  return createGzip({ level: GZIP_LEVEL });
}

function isCompressible(req: Request, res: Response): boolean {
  if (req.method === 'HEAD' || res.headersSent) {
    return false;
  }
  if (res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304) {
    return false;
  }
  if (res.getHeader('content-encoding') !== undefined) {
    return false;
  }
  return COMPRESSIBLE_TYPE.test(String(res.getHeader('content-type') ?? ''));
}

/** tRPC's jsonl responses declare chunked encoding before writing the first line. */
function isDeclaredStream(res: Response): boolean {
  return /\bchunked\b/i.test(String(res.getHeader('transfer-encoding') ?? ''));
}

/** Takes over one response's `write`, `end` and `flush`. */
class CompressingResponse {
  private state: State = { kind: 'undecided' };
  private ended = false;
  private endCallback: Callback | undefined;
  private readonly write: Response['write'];
  private readonly end: Response['end'];

  constructor(
    private readonly req: Request,
    private readonly res: Response,
    private readonly accepted: ContentEncoding | null
  ) {
    this.write = res.write.bind(res);
    this.end = res.end.bind(res);
  }

  install(): void {
    const { res } = this;
    res.write = (
      data: unknown,
      encodingOrCallback?: BufferEncoding | Callback,
      callback?: Callback
    ) => this.onWrite(writeArguments(data, encodingOrCallback, callback));
    res.end = (
      data?: unknown,
      encodingOrCallback?: BufferEncoding | Callback,
      callback?: Callback
    ) => this.onEnd(endArguments(data, encodingOrCallback, callback));
    Object.assign(res, { flush: () => this.onFlush() });
    res.once('close', () => this.onClose());
  }

  private decide(): void {
    if (this.state.kind !== 'undecided') {
      return;
    }
    if (!isCompressible(this.req, this.res)) {
      this.state = { kind: 'identity' };
      return;
    }
    this.res.vary('Accept-Encoding');
    this.state =
      this.accepted === null
        ? { kind: 'identity' }
        : { kind: 'buffering', encoding: this.accepted, chunks: [], size: 0 };
  }

  private buffer(chunk: Buffer | null): void {
    if (this.state.kind === 'buffering' && chunk !== null) {
      this.state.chunks.push(chunk);
      this.state.size += chunk.length;
    }
  }

  private startCompressing(): void {
    if (this.state.kind !== 'buffering') {
      return;
    }
    const { res } = this;
    const { encoding, chunks } = this.state;
    res.setHeader('Content-Encoding', encoding);
    res.removeHeader('Content-Length');
    const compressor = createCompressor(encoding);
    compressor.on('data', (chunk: Buffer) => {
      if (!this.write(chunk)) {
        compressor.pause();
      }
    });
    res.on('drain', () => compressor.resume());
    compressor.on('drain', () => res.emit('drain'));
    compressor.on('end', () => this.end(this.endCallback));
    compressor.on('error', (error) => res.destroy(error));
    for (const chunk of chunks) {
      compressor.write(chunk);
    }
    this.state = { kind: 'compressing', encoding, compressor };
  }

  private onWrite(chunk: Chunk): boolean {
    this.decide();
    if (this.state.kind === 'buffering') {
      this.buffer(toBuffer(chunk));
      if (this.state.size >= COMPRESSION_THRESHOLD_BYTES) {
        this.startCompressing();
      }
      if (chunk.done) {
        process.nextTick(chunk.done);
      }
      return true;
    }
    if (this.state.kind === 'compressing') {
      const { compressor } = this.state;
      // After a disconnect the writer is aborting; drop what it still sends.
      return (
        compressor.destroyed || compressor.write(toBuffer(chunk) ?? Buffer.alloc(0), chunk.done)
      );
    }
    return chunk.encoding === undefined
      ? this.write(chunk.data, chunk.done)
      : this.write(chunk.data, chunk.encoding, chunk.done);
  }

  private onEnd(chunk: Chunk): Response {
    if (this.ended) {
      return this.res;
    }
    this.ended = true;
    this.decide();
    let remaining = this.state.kind === 'identity' ? null : toBuffer(chunk);
    if (this.state.kind === 'buffering') {
      this.buffer(remaining);
      remaining = null;
      if (this.state.size < COMPRESSION_THRESHOLD_BYTES) {
        const body = Buffer.concat(this.state.chunks);
        this.state = { kind: 'identity' };
        return this.end(body, chunk.done);
      }
      this.startCompressing();
    }
    if (this.state.kind === 'compressing') {
      return this.endCompressed(this.state.compressor, remaining, chunk.done);
    }
    if (chunk.data === undefined) {
      return this.end(chunk.done);
    }
    return chunk.encoding === undefined
      ? this.end(chunk.data, chunk.done)
      : this.end(chunk.data, chunk.encoding, chunk.done);
  }

  private endCompressed(
    compressor: Compressor,
    remaining: Buffer | null,
    done: Callback | undefined
  ): Response {
    if (compressor.destroyed) {
      return this.end(done);
    }
    this.endCallback = done;
    if (remaining === null) {
      compressor.end();
    } else {
      compressor.end(remaining);
    }
    return this.res;
  }

  private onFlush(): void {
    if (!isDeclaredStream(this.res)) {
      // A complete body arrives in one write followed by `end`.
      return;
    }
    this.decide();
    this.startCompressing();
    if (this.state.kind === 'compressing' && !this.state.compressor.destroyed) {
      // Gzip's default, Z_FULL_FLUSH, also discards the dictionary built from
      // earlier lines; a sync flush sends the pending bytes and keeps it.
      this.state.compressor.flush(
        this.state.encoding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH
      );
    }
  }

  private onClose(): void {
    if (this.state.kind === 'compressing') {
      this.state.compressor.destroy();
    } else if (this.state.kind === 'buffering') {
      this.state.chunks = [];
    }
  }
}

/**
 * Compresses JSON responses for clients that accept Brotli or gzip, keeping
 * streamed responses streaming. The coding is chosen when the handler first
 * writes, from the status and headers it has set by then.
 *
 * A complete body is held until it reaches the threshold, so a small one goes
 * out uncompressed with a `Content-Length`. A stream (a chunked response whose
 * writer calls `res.flush()` after each line, as tRPC's jsonl writer does) has
 * to commit to a coding before its total is known, so its first flush starts
 * compression; every flush then sends the compressed line at once.
 */
export function createResponseCompression(): RequestHandler {
  return (req, res, next) => {
    new CompressingResponse(
      req,
      res,
      selectContentEncoding(req.headers['accept-encoding'])
    ).install();
    next();
  };
}
