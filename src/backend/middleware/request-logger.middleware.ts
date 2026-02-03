import type { NextFunction, Request, Response } from 'express';
import { type AppContext, createAppContext } from '../app-context';

/**
 * Request logging middleware.
 * Logs HTTP requests with method, path, status, and duration.
 * Skips logging for /health endpoints to reduce noise.
 */
export function createRequestLoggerMiddleware(appContext: AppContext) {
  const logger = appContext.services.createLogger('server');

  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path !== '/health' && !req.path.startsWith('/health/')) {
        logger.debug('HTTP request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
        });
      }
    });
    next();
  };
}

export const requestLoggerMiddleware = createRequestLoggerMiddleware(createAppContext());
