import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the router
const mockQueryRaw = vi.fn();
const mockGetEnvironment = vi.fn();
const mockGetAppVersion = vi.fn();
const mockGetApiUsageStats = vi.fn();

vi.mock('../../db', () => ({
  prisma: {
    $queryRaw: () => mockQueryRaw(),
  },
}));

vi.mock('../../services/index', () => ({
  configService: {
    getEnvironment: () => mockGetEnvironment(),
    getAppVersion: () => mockGetAppVersion(),
  },
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  rateLimiter: {
    getApiUsageStats: () => mockGetApiUsageStats(),
  },
}));

// Import after mocks are set up
import { healthRouter } from './health.router';

describe('healthRouter', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use('/health', healthRouter);

    // Set default mock returns
    mockGetEnvironment.mockReturnValue('development');
    mockGetAppVersion.mockReturnValue('0.1.0');
    mockQueryRaw.mockResolvedValue([{ '1': 1 }]);
    mockGetApiUsageStats.mockReturnValue({
      requestsLastMinute: 10,
      requestsLastHour: 100,
      totalRequests: 500,
      queueDepth: 0,
      isRateLimited: false,
    });
  });

  describe('GET / (basic health)', () => {
    it('returns status ok', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });

    it('returns timestamp', async () => {
      const beforeTime = new Date().toISOString();
      const response = await request(app).get('/health');
      const afterTime = new Date().toISOString();

      expect(response.status).toBe(200);
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.timestamp >= beforeTime).toBe(true);
      expect(response.body.timestamp <= afterTime).toBe(true);
    });

    it('returns service name', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.service).toBe('factoryfactory-backend');
    });

    it('returns environment', async () => {
      mockGetEnvironment.mockReturnValue('production');

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.environment).toBe('production');
    });

    it('returns version', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.version).toBeDefined();
    });
  });

  describe('GET /database', () => {
    it('returns status ok when database is connected', async () => {
      mockQueryRaw.mockResolvedValue([{ '1': 1 }]);

      const response = await request(app).get('/health/database');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.database).toBe('connected');
      expect(response.body.timestamp).toBeDefined();
    });

    it('returns status 503 when database query fails', async () => {
      mockQueryRaw.mockRejectedValue(new Error('Connection refused'));

      const response = await request(app).get('/health/database');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(response.body.database).toBe('disconnected');
      expect(response.body.error).toBe('Connection refused');
      expect(response.body.timestamp).toBeDefined();
    });

    it('handles unknown error types', async () => {
      mockQueryRaw.mockRejectedValue('Unknown error string');

      const response = await request(app).get('/health/database');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(response.body.error).toBe('Unknown error');
    });
  });

  describe('GET /all (comprehensive)', () => {
    it('returns overall status ok when all checks pass', async () => {
      mockQueryRaw.mockResolvedValue([{ '1': 1 }]);
      mockGetApiUsageStats.mockReturnValue({
        requestsLastMinute: 10,
        requestsLastHour: 100,
        totalRequests: 500,
        queueDepth: 0,
        isRateLimited: false,
      });

      const response = await request(app).get('/health/all');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.checks).toBeDefined();
      expect(response.body.checks.database.status).toBe('ok');
      expect(response.body.checks.rateLimiter.status).toBe('ok');
    });

    it('returns status degraded when rate limited', async () => {
      mockQueryRaw.mockResolvedValue([{ '1': 1 }]);
      mockGetApiUsageStats.mockReturnValue({
        requestsLastMinute: 60,
        requestsLastHour: 1000,
        totalRequests: 5000,
        queueDepth: 10,
        isRateLimited: true,
      });

      const response = await request(app).get('/health/all');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('degraded');
      expect(response.body.checks.database.status).toBe('ok');
      expect(response.body.checks.rateLimiter.status).toBe('degraded');
      expect(response.body.checks.rateLimiter.details.isRateLimited).toBe(true);
    });

    it('returns status error when database fails', async () => {
      mockQueryRaw.mockRejectedValue(new Error('Database connection lost'));
      mockGetApiUsageStats.mockReturnValue({
        requestsLastMinute: 10,
        requestsLastHour: 100,
        totalRequests: 500,
        queueDepth: 0,
        isRateLimited: false,
      });

      const response = await request(app).get('/health/all');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(response.body.checks.database.status).toBe('error');
      expect(response.body.checks.database.details).toBe('Database connection lost');
      expect(response.body.checks.rateLimiter.status).toBe('ok');
    });

    it('returns error status over degraded when both database fails and rate limited', async () => {
      mockQueryRaw.mockRejectedValue(new Error('Database error'));
      mockGetApiUsageStats.mockReturnValue({
        requestsLastMinute: 60,
        requestsLastHour: 1000,
        totalRequests: 5000,
        queueDepth: 10,
        isRateLimited: true,
      });

      const response = await request(app).get('/health/all');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(response.body.checks.database.status).toBe('error');
      expect(response.body.checks.rateLimiter.status).toBe('degraded');
    });

    it('includes rate limiter stats', async () => {
      mockQueryRaw.mockResolvedValue([{ '1': 1 }]);
      mockGetApiUsageStats.mockReturnValue({
        requestsLastMinute: 25,
        requestsLastHour: 200,
        totalRequests: 1000,
        queueDepth: 5,
        isRateLimited: false,
      });

      const response = await request(app).get('/health/all');

      expect(response.status).toBe(200);
      expect(response.body.checks.rateLimiter.details).toEqual({
        requestsLastMinute: 25,
        isRateLimited: false,
      });
    });

    it('handles unknown database error types', async () => {
      mockQueryRaw.mockRejectedValue('String error');
      mockGetApiUsageStats.mockReturnValue({
        requestsLastMinute: 10,
        requestsLastHour: 100,
        totalRequests: 500,
        queueDepth: 0,
        isRateLimited: false,
      });

      const response = await request(app).get('/health/all');

      expect(response.status).toBe(503);
      expect(response.body.checks.database.details).toBe('Unknown error');
    });
  });
});
