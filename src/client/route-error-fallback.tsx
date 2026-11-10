import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ErrorFallback, normalizeThrownError } from './error-boundary';

/** Converts a router error, including a thrown `Response`, into an `Error` for the fallback. */
export function routeErrorToError(error: unknown): Error {
  if (isRouteErrorResponse(error)) {
    const message = `${error.status} ${error.statusText}`.trim();
    return new Error(message, { cause: error });
  }
  return normalizeThrownError(error);
}

/**
 * The root route's `errorElement`, replacing react-router's unstyled default
 * screen for errors the app's boundaries do not catch, such as loader errors.
 */
export function RouteErrorFallback() {
  const error = useRouteError();
  return <ErrorFallback error={routeErrorToError(error)} className="min-h-dvh" />;
}
