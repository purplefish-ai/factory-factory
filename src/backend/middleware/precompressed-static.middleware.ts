import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import express, { type Request, type RequestHandler, type Response } from 'express';
import {
  CONTENT_ENCODINGS,
  type ContentEncoding,
  PRECOMPRESSED_SUFFIXES,
  selectContentEncoding,
} from './content-encoding';

type StaticOptions = NonNullable<Parameters<typeof express.static>[1]>;

/** URL path below the mount point → codings with a sibling file on disk. */
function scanPrecompressedFiles(root: string): Map<string, ContentEncoding[]> {
  const files = new Set(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
  );
  const variants = new Map<string, ContentEncoding[]>();
  for (const file of files) {
    const encodings = CONTENT_ENCODINGS.filter((encoding) =>
      files.has(`${file}${PRECOMPRESSED_SUFFIXES[encoding]}`)
    );
    if (encodings.length > 0) {
      variants.set(`/${file}`, encodings);
    }
  }
  return variants;
}

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * `express.static` that serves a build-time `.br`/`.gz` sibling when the client
 * accepts it, keeping the original file's content type and cache headers. The
 * sibling list is read once here; files outside it are served unchanged.
 */
export function createPrecompressedStatic(root: string, options: StaticOptions): RequestHandler {
  const variants = scanPrecompressedFiles(root);
  const servingEncoding = new WeakMap<Response, ContentEncoding>();
  const serve = express.static(root, {
    ...options,
    setHeaders: (res, filePath, stat) => {
      const encoding = servingEncoding.get(res);
      if (encoding === undefined) {
        options.setHeaders?.(res, filePath, stat);
        return;
      }
      const originalPath = filePath.slice(0, -PRECOMPRESSED_SUFFIXES[encoding].length);
      // `send` keeps a preset Content-Type instead of deriving one from `.br`.
      res.type(extname(originalPath));
      res.setHeader('Content-Encoding', encoding);
      options.setHeaders?.(res, originalPath, stat);
    },
  });

  return (req, res, next) => {
    const path = req.method === 'GET' || req.method === 'HEAD' ? decodePath(req.path) : null;
    const available = path === null ? undefined : variants.get(path);
    if (!available) {
      serve(req, res, next);
      return;
    }
    res.vary('Accept-Encoding');
    const encoding = selectContentEncoding(req.headers['accept-encoding'], available);
    if (encoding === null) {
      serve(req, res, next);
      return;
    }
    const originalUrl = req.url;
    const queryIndex = originalUrl.indexOf('?');
    const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
    const search = queryIndex === -1 ? '' : originalUrl.slice(queryIndex);
    req.url = `${pathname}${PRECOMPRESSED_SUFFIXES[encoding]}${search}`;
    servingEncoding.set(res, encoding);
    serve(req, res, (error?: unknown) => {
      req.url = originalUrl;
      servingEncoding.delete(res);
      if (error) {
        next(error);
        return;
      }
      // The sibling vanished after startup: serve the original file instead.
      serve(req, res, next);
    });
  };
}

/** An in-memory document with any build-time compressed siblings. */
export interface PrecompressedDocument {
  body: string;
  encoded: ReadonlyMap<ContentEncoding, Buffer>;
}

/** Reads a file and its `.br`/`.gz` siblings together so they stay consistent. */
export function readPrecompressedDocument(filePath: string): PrecompressedDocument {
  const body = readFileSync(filePath, 'utf8');
  const encoded = new Map<ContentEncoding, Buffer>();
  for (const encoding of CONTENT_ENCODINGS) {
    const siblingPath = `${filePath}${PRECOMPRESSED_SUFFIXES[encoding]}`;
    if (existsSync(siblingPath)) {
      encoded.set(encoding, readFileSync(siblingPath));
    }
  }
  return { body, encoded };
}

/** Sends an HTML document, using a precompressed variant when the client accepts it. */
export function sendPrecompressedHtml(
  req: Request,
  res: Response,
  document: PrecompressedDocument
): void {
  res.type('html');
  if (document.encoded.size === 0) {
    res.send(document.body);
    return;
  }
  res.vary('Accept-Encoding');
  const encoding = selectContentEncoding(req.headers['accept-encoding'], [
    ...document.encoded.keys(),
  ]);
  const encoded = encoding === null ? undefined : document.encoded.get(encoding);
  if (encoding === null || encoded === undefined) {
    res.send(document.body);
    return;
  }
  res.setHeader('Content-Encoding', encoding);
  res.send(encoded);
}
