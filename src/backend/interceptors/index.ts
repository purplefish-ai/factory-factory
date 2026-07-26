/**
 * Tool Interceptors
 *
 * Interceptors observe tool events and trigger side effects.
 * They are registered at startup and notified of tool start/complete events.
 */

import { branchNamingInterceptor } from './branch-naming.interceptor';
import { conversationRenameInterceptor } from './conversation-rename.interceptor';
import { prDetectionInterceptor } from './pr-detection.interceptor';
import { interceptorRegistry } from './registry';

/**
 * Register all interceptors. Called at server startup.
 */
export function registerInterceptors(): void {
  interceptorRegistry.register(branchNamingInterceptor);
  interceptorRegistry.register(conversationRenameInterceptor);
  interceptorRegistry.register(prDetectionInterceptor);
}

/**
 * Start all interceptor lifecycle hooks.
 */
export async function startInterceptors(): Promise<void> {
  await interceptorRegistry.start();
}

/**
 * Stop all interceptor lifecycle hooks.
 */
export async function stopInterceptors(): Promise<void> {
  await interceptorRegistry.stop();
}

export { interceptorRegistry } from './registry';
export type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';
