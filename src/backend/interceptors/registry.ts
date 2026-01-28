/**
 * InterceptorRegistry - manages tool interceptors and dispatches events.
 *
 * Key principles:
 * - Fire-and-forget: Interceptors don't block tool execution
 * - Fail-safe: Errors are logged but don't break the main flow
 * - Selective: Interceptors declare which tools they care about
 */

import { createLogger } from '../services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('interceptor-registry');

class InterceptorRegistry {
  private interceptors: ToolInterceptor[] = [];

  /**
   * Register an interceptor.
   */
  register(interceptor: ToolInterceptor): void {
    this.interceptors.push(interceptor);
    logger.info('Registered interceptor', { name: interceptor.name, tools: interceptor.tools });
  }

  /**
   * Check if an interceptor should handle a given tool.
   */
  private shouldHandle(interceptor: ToolInterceptor, toolName: string): boolean {
    if (interceptor.tools === '*') {
      return true;
    }
    return interceptor.tools.includes(toolName);
  }

  /**
   * Notify interceptors of a tool start event.
   * Fire-and-forget with error handling for each interceptor.
   */
  notifyToolStart(event: ToolEvent, context: InterceptorContext): void {
    for (const interceptor of this.interceptors) {
      if (!interceptor.onToolStart) {
        continue;
      }
      if (!this.shouldHandle(interceptor, event.toolName)) {
        continue;
      }

      // Fire and forget - don't await
      interceptor.onToolStart(event, context).catch((error) => {
        logger.error('Interceptor onToolStart error', {
          interceptor: interceptor.name,
          toolName: event.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Notify interceptors of a tool complete event.
   * Fire-and-forget with error handling for each interceptor.
   */
  notifyToolComplete(event: ToolEvent, context: InterceptorContext): void {
    for (const interceptor of this.interceptors) {
      if (!interceptor.onToolComplete) {
        continue;
      }
      if (!this.shouldHandle(interceptor, event.toolName)) {
        continue;
      }

      // Fire and forget - don't await
      interceptor.onToolComplete(event, context).catch((error) => {
        logger.error('Interceptor onToolComplete error', {
          interceptor: interceptor.name,
          toolName: event.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}

export const interceptorRegistry = new InterceptorRegistry();
