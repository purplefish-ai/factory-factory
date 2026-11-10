import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { RequestHandler, Response } from 'express';
import { type ContentEncoding, selectContentEncoding } from './content-encoding';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Below this, compression saves too little to pay for itself. */
export const JSON_COMPRESSION_THRESHOLD_BYTES = 1024;

// Low levels keep request-time CPU small: well under a millisecond for tens of KB.
const encoders: Record<ContentEncoding, (body: Buffer) => Promise<Buffer>> = {
  br: (body) =>
    brotliAsync(body, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 4,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    }),
  gzip: (body) => gzipAsync(body, { level: 1 }),
};

/** Streamed tRPC batches (`httpBatchStreamLink`) and SSE must reach the client unbuffered. */
function isStreamingRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const accepts = [headers['trpc-accept'], headers.accept].flat().join(',').toLowerCase();
  return accepts.includes('application/jsonl') || accepts.includes('text/event-stream');
}

function isPlainJsonResponse(res: Response): boolean {
  const contentType = res.getHeader('Content-Type');
  return (
    !res.headersSent &&
    typeof contentType === 'string' &&
    /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType) &&
    res.getHeader('Content-Encoding') === undefined &&
    res.getHeader('Transfer-Encoding') === undefined
  );
}

function isBufferEncoding(value: unknown): value is BufferEncoding {
  return typeof value === 'string' && Buffer.isEncoding(value);
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer | null {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, isBufferEncoding(encoding) ? encoding : 'utf8');
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

type Callback = (error?: Error | null) => void;
type Write = (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;
type End = (chunk?: unknown, encoding?: unknown, callback?: unknown) => Response;

function findCallback(...args: unknown[]): Callback | undefined {
  return args.find((argument): argument is Callback => typeof argument === 'function');
}

/**
 * Compresses complete JSON responses above a size threshold for clients that
 * accept br or gzip. Streaming requests are never wrapped. Other responses are
 * buffered only if, when the body starts, their headers show a single JSON
 * document: not chunked, not already encoded, not another content type.
 */
export function createJsonCompressionMiddleware(
  threshold = JSON_COMPRESSION_THRESHOLD_BYTES
): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'HEAD' || isStreamingRequest(req.headers)) {
      next();
      return;
    }
    const encoding = selectContentEncoding(req.headers['accept-encoding']);
    const originalWrite = res.write;
    const originalEnd = res.end;
    const write: Write = (...args) => Reflect.apply(originalWrite, res, args);
    const end: End = (...args) => Reflect.apply(originalEnd, res, args);
    const chunks: Buffer[] = [];
    let buffering: boolean | null = null;

    const passThrough = () => {
      buffering = false;
      res.write = originalWrite;
      res.end = originalEnd;
      for (const pending of chunks.splice(0)) {
        write(pending);
      }
    };
    const startBody = () => {
      buffering ??= isPlainJsonResponse(res);
      return buffering;
    };

    const finish = (body: Buffer, done: Callback | undefined) => {
      res.vary('Accept-Encoding');
      const bodyless = res.statusCode === 204 || res.statusCode === 304;
      if (encoding === null || body.length < threshold || bodyless) {
        end(body, done);
        return;
      }
      encoders[encoding](body).then(
        (compressed) => {
          if (res.headersSent) {
            end(body, done);
            return;
          }
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Length', compressed.length);
          end(compressed, done);
        },
        () => end(body, done)
      );
    };

    const bufferingWrite: Write = (chunk, chunkEncoding, callback) => {
      const buffer = startBody() ? toBuffer(chunk, chunkEncoding) : null;
      if (buffer === null) {
        passThrough();
        return write(chunk, chunkEncoding, callback);
      }
      chunks.push(buffer);
      const done = findCallback(chunkEncoding, callback);
      if (done) {
        process.nextTick(done);
      }
      return true;
    };

    const bufferingEnd: End = (chunk, chunkEncoding, callback) => {
      const hasChunk = chunk !== undefined && chunk !== null && typeof chunk !== 'function';
      const tail = hasChunk ? toBuffer(chunk, chunkEncoding) : null;
      if (!startBody() || (hasChunk && tail === null)) {
        passThrough();
        return end(chunk, chunkEncoding, callback);
      }
      res.write = originalWrite;
      res.end = originalEnd;
      if (tail !== null) {
        chunks.push(tail);
      }
      finish(Buffer.concat(chunks), findCallback(chunk, chunkEncoding, callback));
      return res;
    };

    res.write = bufferingWrite as typeof res.write;
    res.end = bufferingEnd as typeof res.end;
    next();
  };
}
