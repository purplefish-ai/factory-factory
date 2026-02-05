/**
 * Tool Interceptors
 *
 * Interceptors observe tool events and trigger side effects.
 * They are registered at startup and notified of tool start/complete events.
 */

import { branchRenameInterceptor } from './branch-rename.interceptor';
import { conversationRenameInterceptor } from './conversation-rename.interceptor';
import { prDetectionInterceptor } from './pr-detection.interceptor';
import { interceptorRegistry } from './registry';

/**
 * Register all interceptors. Called at server startup.
 */
export function registerInterceptors(): void {
  interceptorRegistry.register(branchRenameInterceptor);
  interceptorRegistry.register(conversationRenameInterceptor);
  interceptorRegistry.register(prDetectionInterceptor);
}

export { interceptorRegistry } from './registry';
export type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';
