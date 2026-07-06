import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { createContext } from './trpc';

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
