import type { NextFunction, Request, Response } from 'express';

/**
 * Security headers middleware.
 * Sets standard security headers to protect against common web vulnerabilities.
 */
export function securityMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}
