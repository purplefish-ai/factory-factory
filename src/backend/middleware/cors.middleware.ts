import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '@/backend/app-context';
import { isOriginAllowed } from '@/backend/lib/request-trust';

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
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origin) {
      // Use the value from the trusted allowlist rather than reflecting the raw
      // request origin, so static analysis sees no user-controlled input in the
      // Access-Control-Allow-Origin header for credentialed responses.
      const exactMatch = corsConfig.allowedOrigins.find((o) => o === origin);
      if (exactMatch !== undefined) {
        res.header('Access-Control-Allow-Origin', exactMatch);
        res.header('Access-Control-Allow-Credentials', 'true');
      } else if (isOriginAllowed(origin, corsConfig.allowedOrigins)) {
        // Loopback-equivalence match (127.x.x.x ↔ localhost): allow the request
        // without credentials — CORS_DISABLE covers dev; this handles edge cases.
        res.header('Access-Control-Allow-Origin', origin);
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
