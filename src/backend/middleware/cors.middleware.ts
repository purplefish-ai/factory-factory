import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '@/backend/app-context';
import { resolveAllowedOrigin } from '@/backend/lib/request-trust';

/**
 * CORS middleware.
 * Configures Cross-Origin Resource Sharing based on CORS_ALLOWED_ORIGINS env var.
 * The CLI sets this automatically to the frontend origin; fallback defaults are
 * only used when running outside the CLI (e.g., Docker, custom deployments).
 * Handles OPTIONS preflight requests.
 */
export function createCorsMiddleware(appContext: AppContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const corsConfig = appContext.services.configService.getCorsConfig();
    const origin = req.headers.origin;

    if (corsConfig.disabled) {
      // Dev-only bypass: no credentials header is set, so browsers cannot issue
      // credentialed cross-origin requests even though the origin check is skipped.
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origin) {
      // Echo a value taken from the trusted allowlist (never the raw request
      // header) so credentialed responses never carry user-controlled input in
      // the Access-Control-Allow-Origin header.
      const allowedOrigin = resolveAllowedOrigin(origin, corsConfig.allowedOrigins);
      if (allowedOrigin !== undefined) {
        res.header('Access-Control-Allow-Origin', allowedOrigin);
        res.header('Access-Control-Allow-Credentials', 'true');
      }
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Project-Id, X-Top-Level-Task-Id'
    );

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  };
}
