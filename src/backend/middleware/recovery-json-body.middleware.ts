import express, { type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  assertRecoveryWireBudget,
  MAX_RECOVERY_HTTP_BODY_BYTES,
} from '@/shared/recovery-wire-budget';

const IMPORT_PATH = '/api/trpc/admin.importData';
const envelope = z.strictObject({
  json: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
const singleBatch = z.strictObject({ 0: envelope });

function rejectBody(res: Response, status: 400 | 413, message: string): void {
  // SuperJSON tRPC errors are readable by both ordinary and batched clients.
  res.status(status).json({
    error: {
      json: {
        message,
        code: status === 413 ? -32_013 : -32_600,
        data: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', httpStatus: status },
      },
    },
  });
}

function rejectParseError(error: unknown, res: Response): void {
  const tooLarge = error instanceof Error && 'status' in error && error.status === 413;
  rejectBody(
    res,
    tooLarge ? 413 : 400,
    tooLarge ? 'JSON request body exceeds the allowed size.' : 'Invalid JSON request body.'
  );
}

function validateImportEnvelope(req: Request, res: Response): boolean {
  const batched = new URL(req.originalUrl, 'http://localhost').searchParams.get('batch') === '1';
  const body: unknown = req.body;
  const parsed = batched ? singleBatch.safeParse(body) : envelope.safeParse(body);
  if (!parsed.success) {
    rejectBody(res, 400, 'Invalid recovery import request envelope.');
    return false;
  }
  const input = '0' in parsed.data ? parsed.data[0] : parsed.data;
  try {
    assertRecoveryWireBudget(input.json);
  } catch {
    rejectBody(res, 413, 'Recovery package exceeds the 64 MiB serialized JSON limit.');
    return false;
  }
  return true;
}

/** Widen only the exact import mutation; every other API retains its 10 MiB cap. */
export function createRecoveryJsonBodyMiddleware(): RequestHandler {
  const normalJson = express.json({ limit: '10mb' });
  const recoveryJson = express.json({ limit: MAX_RECOVERY_HTTP_BODY_BYTES });
  return (req, res, next) => {
    const isImport = req.method === 'POST' && req.path === IMPORT_PATH;
    const paths = req.path.slice('/api/trpc/'.length).split(',');
    if (
      req.method === 'POST' &&
      req.path.startsWith('/api/trpc/') &&
      paths.includes('admin.importData') &&
      !isImport
    ) {
      rejectBody(res, 400, 'Recovery imports must be sent as a single request.');
      return;
    }
    // Fail declared oversize imports before body-parser waits to drain a body.
    // Its streaming limit still covers chunked bodies and compressed expansion.
    if (isImport && Number(req.headers['content-length']) > MAX_RECOVERY_HTTP_BODY_BYTES) {
      rejectBody(res, 413, 'JSON request body exceeds the allowed size.');
      return;
    }
    const parse = isImport ? recoveryJson : normalJson;
    parse(req, res, (error?: unknown) => {
      if (error) {
        rejectParseError(error, res);
        return;
      }
      if (isImport && !validateImportEnvelope(req, res)) {
        return;
      }
      next();
    });
  };
}
