import { TRPCError } from '@trpc/server';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import { createContext, publicProcedure, router } from './trpc';

describe('createContext request trust', () => {
  it('prefers Express proxy-aware req.ip over the socket remote address', () => {
    const contextFactory = createContext({} as never);
    const ctx = contextFactory({
      req: {
        headers: {},
        ip: '203.0.113.10',
        socket: { remoteAddress: '127.0.0.1' },
      } as Request,
    });

    expect(ctx.requestTrust).toMatchObject({
      remoteAddress: '203.0.113.10',
      isLocal: false,
    });
  });
});

describe('publicProcedure application error translation', () => {
  it('translates downstream application errors to tRPC errors', async () => {
    const cause = new Error('internal detail');
    const testRouter = router({
      fail: publicProcedure.query(() => {
        throw new ApplicationError('NOT_FOUND', 'Record not found', { cause });
      }),
    });

    await expect(testRouter.createCaller({} as never).fail()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Record not found',
      cause: expect.objectContaining({
        code: 'NOT_FOUND',
        cause,
      }),
    });
  });

  it('passes through existing tRPC errors', async () => {
    const error = new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
    const testRouter = router({
      fail: publicProcedure.query(() => {
        throw error;
      }),
    });

    await expect(testRouter.createCaller({} as never).fail()).rejects.toBe(error);
  });

  it('passes through unknown errors', async () => {
    const cause = new Error('Unexpected failure');
    const testRouter = router({
      fail: publicProcedure.query(() => {
        throw cause;
      }),
    });

    await expect(testRouter.createCaller({} as never).fail()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause,
    });
  });
});
