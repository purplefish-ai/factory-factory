import { Router } from 'express';
import type { AppContext } from '@/backend/app-context';
import { HTTP_STATUS } from '@/backend/constants';
import { healthService } from '@/backend/services/health.service';

// ============================================================================
// Health Check Routes
// ============================================================================

export function createHealthRouter(appContext: AppContext): Router {
  const router = Router();
  const logger = appContext.services.createLogger('health-route');

  /**
   * GET /health
   * Basic health check - returns service status and metadata
   */
  router.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'factoryfactory-backend',
      version: appContext.services.configService.getAppVersion(),
      environment: appContext.services.configService.getEnvironment(),
    });
  });

  /**
   * GET /health/database
   * Database connectivity health check
   */
  router.get('/database', async (_req, res) => {
    try {
      await healthService.checkDatabaseConnection();
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: 'connected',
      });
    } catch (error) {
      logger.error('Database health check failed', error as Error);
      res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /health/all
   * Comprehensive health check - database + rate limiter status
   */
  router.get('/all', async (_req, res) => {
    const checks: Record<string, { status: string; details?: unknown }> = {};

    try {
      await healthService.checkDatabaseConnection();
      checks.database = { status: 'ok' };
    } catch (error) {
      checks.database = {
        status: 'error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    const apiUsage = appContext.services.rateLimiter.getApiUsageStats();
    checks.rateLimiter = {
      status: apiUsage.isRateLimited ? 'degraded' : 'ok',
      details: {
        requestsLastMinute: apiUsage.requestsLastMinute,
        isRateLimited: apiUsage.isRateLimited,
      },
    };

    const statuses = Object.values(checks).map((c) => c.status);
    let overallStatus = 'ok';
    if (statuses.includes('error')) {
      overallStatus = 'error';
    } else if (statuses.includes('degraded')) {
      overallStatus = 'degraded';
    }

    res.status(overallStatus === 'error' ? HTTP_STATUS.SERVICE_UNAVAILABLE : HTTP_STATUS.OK).json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  return router;
}
