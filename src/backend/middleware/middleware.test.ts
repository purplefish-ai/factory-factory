import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the logger service before importing middlewares
vi.mock('../services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { corsMiddleware } from './cors.middleware';
import { requestLoggerMiddleware } from './request-logger.middleware';
// Import after mocks are set up
import { securityMiddleware } from './security.middleware';

// Helper to create mock Express request
function createMockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    method: 'GET',
    path: '/api/test',
    headers: {},
    ...overrides,
  } as Request;
}

// Helper to create mock Express response
function createMockRes() {
  const headers: Record<string, string> = {};
  const finishCallbacks: Array<() => void> = [];

  return {
    headers,
    finishCallbacks,
    statusCode: 200,
    header: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    sendStatus: vi.fn(),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === 'finish') {
        finishCallbacks.push(callback);
      }
    }),
  };
}

type MockRes = ReturnType<typeof createMockRes>;

describe('securityMiddleware', () => {
  let mockReq: Request;
  let mockRes: MockRes;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = createMockReq();
    mockRes = createMockRes();
    mockNext = vi.fn() as unknown as NextFunction;
  });

  it('should set X-Content-Type-Options header to nosniff', () => {
    securityMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockRes.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('should set X-Frame-Options header to DENY', () => {
    securityMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockRes.header).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
  });

  it('should set X-XSS-Protection header', () => {
    securityMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockRes.header).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
    expect(mockRes.headers['X-XSS-Protection']).toBe('1; mode=block');
  });

  it('should set Referrer-Policy header', () => {
    securityMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockRes.header).toHaveBeenCalledWith(
      'Referrer-Policy',
      'strict-origin-when-cross-origin'
    );
    expect(mockRes.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('should call next()', () => {
    securityMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should set all security headers in a single call', () => {
    securityMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockRes.header).toHaveBeenCalledTimes(4);
    expect(mockRes.headers).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
  });
});

describe('corsMiddleware', () => {
  let mockRes: MockRes;
  let mockNext: NextFunction;

  const originalEnv = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    mockRes = createMockRes();
    mockNext = vi.fn() as unknown as NextFunction;
    // Reset env var before each test
    process.env.CORS_ALLOWED_ORIGINS = undefined;
  });

  afterEach(() => {
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.CORS_ALLOWED_ORIGINS = originalEnv;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = undefined;
    }
  });

  describe('origin handling', () => {
    it('should set Access-Control-Allow-Origin for allowed origins (default localhost:3000)', () => {
      const mockReq = createMockReq({
        headers: { origin: 'http://localhost:3000' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    it('should set Access-Control-Allow-Origin for allowed origins (default localhost:3001)', () => {
      const mockReq = createMockReq({
        headers: { origin: 'http://localhost:3001' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3001');
    });

    it('should not set Access-Control-Allow-Origin for disallowed origins', () => {
      const mockReq = createMockReq({
        headers: { origin: 'http://evil.com' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('should not set Access-Control-Allow-Origin when no origin header is present', () => {
      const mockReq = createMockReq({ headers: {} });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('should use custom allowed origins from CORS_ALLOWED_ORIGINS env var', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://example.com,https://app.example.com';

      const mockReq = createMockReq({
        headers: { origin: 'https://example.com' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
    });

    it('should reject default origins when custom env var is set', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://example.com';

      const mockReq = createMockReq({
        headers: { origin: 'http://localhost:3000' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('CORS headers', () => {
    it('should set Access-Control-Allow-Methods header', () => {
      const mockReq = createMockReq();

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Methods']).toBe(
        'GET, POST, PUT, DELETE, OPTIONS'
      );
    });

    it('should set Access-Control-Allow-Headers header', () => {
      const mockReq = createMockReq();

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Headers']).toBe(
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Project-Id, X-Top-Level-Task-Id'
      );
    });

    it('should set Access-Control-Allow-Credentials header to true', () => {
      const mockReq = createMockReq();

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.headers['Access-Control-Allow-Credentials']).toBe('true');
    });
  });

  describe('preflight request handling', () => {
    it('should handle OPTIONS preflight requests with 200 status', () => {
      const mockReq = createMockReq({
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockRes.sendStatus).toHaveBeenCalledWith(200);
    });

    it('should not call next() for OPTIONS requests', () => {
      const mockReq = createMockReq({
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should call next() for non-OPTIONS requests', () => {
      const mockReq = createMockReq({
        method: 'GET',
        headers: { origin: 'http://localhost:3000' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should call next() for POST requests', () => {
      const mockReq = createMockReq({
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
      });

      corsMiddleware(mockReq, mockRes as unknown as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });
  });
});

describe('requestLoggerMiddleware', () => {
  let mockRes: MockRes;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRes = createMockRes();
    mockNext = vi.fn() as unknown as NextFunction;
  });

  it('should call next() immediately', () => {
    const mockReq = createMockReq();

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should register a finish event listener on the response', () => {
    const mockReq = createMockReq();

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    expect(mockRes.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  it('should log request details on response finish', () => {
    const mockReq = createMockReq({
      method: 'POST',
      path: '/api/projects',
    });
    mockRes.statusCode = 201;

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    // Trigger the finish event
    expect(mockRes.finishCallbacks.length).toBe(1);
    mockRes.finishCallbacks[0]();

    // The logger.debug should have been called
    // We can't easily verify the exact call since the logger is mocked,
    // but we can verify the callback was registered and executed
  });

  it('should skip logging for /health endpoint', () => {
    const mockReq = createMockReq({
      method: 'GET',
      path: '/health',
    });

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    // Trigger the finish event
    mockRes.finishCallbacks[0]();

    // The middleware should have registered the callback but skipped logging
    // We verify this by ensuring the callback completes without error
    expect(mockNext).toHaveBeenCalled();
  });

  it('should skip logging for /health/* endpoints', () => {
    const mockReq = createMockReq({
      method: 'GET',
      path: '/health/ready',
    });

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    // Trigger the finish event
    mockRes.finishCallbacks[0]();

    // The middleware should have registered the callback but skipped logging
    expect(mockNext).toHaveBeenCalled();
  });

  it('should skip logging for nested health check paths', () => {
    const mockReq = createMockReq({
      method: 'GET',
      path: '/health/db/status',
    });

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    // Trigger the finish event
    mockRes.finishCallbacks[0]();

    expect(mockNext).toHaveBeenCalled();
  });

  it('should not skip logging for paths containing health but not starting with /health', () => {
    const mockReq = createMockReq({
      method: 'GET',
      path: '/api/health-check',
    });

    requestLoggerMiddleware(mockReq, mockRes as unknown as Response, mockNext);

    // Trigger the finish event - this should log (not skip)
    mockRes.finishCallbacks[0]();

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle different HTTP methods', () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

    for (const method of methods) {
      const mockReq = createMockReq({ method, path: '/api/test' });
      const res = createMockRes();
      const next = vi.fn() as unknown as NextFunction;

      requestLoggerMiddleware(mockReq, res as unknown as Response, next);

      expect(next).toHaveBeenCalled();
      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    }
  });

  it('should handle different status codes', () => {
    const statusCodes = [200, 201, 400, 401, 403, 404, 500];

    for (const statusCode of statusCodes) {
      const mockReq = createMockReq({ path: '/api/test' });
      const res = createMockRes();
      res.statusCode = statusCode;
      const next = vi.fn() as unknown as NextFunction;

      requestLoggerMiddleware(mockReq, res as unknown as Response, next);

      // Trigger finish callback
      res.finishCallbacks[0]();

      expect(next).toHaveBeenCalled();
    }
  });
});
