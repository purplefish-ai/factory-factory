import type { NextFunction, Request, Response } from 'express';
import { type AppContext, createAppContext } from '@/backend/app-context';

/**
 * CORS middleware.
 * Configures Cross-Origin Resource Sharing based on CORS_ALLOWED_ORIGINS env var.
 * Defaults to localhost:3000 and localhost:3001 if not specified.
 * Handles OPTIONS preflight requests.
 */
export function createCorsMiddleware(appContext: AppContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ALLOWED_ORIGINS = appContext.services.configService.getCorsConfig().allowedOrigins;

    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Project-Id, X-Top-Level-Task-Id'
    );
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  };
}

export const corsMiddleware = createCorsMiddleware(createAppContext());
