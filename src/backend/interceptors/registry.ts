/**
 * InterceptorRegistry - manages tool interceptors and dispatches events.
 *
 * Key principles:
 * - Fire-and-forget: Interceptors don't block tool execution
 * - Fail-safe: Errors are logged but don't break the main flow
 * - Selective: Interceptors declare which tools they care about
 */

import { createLogger } from '@/backend/services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('interceptor-registry');

class InterceptorRegistry {
  private interceptors: ToolInterceptor[] = [];
  private started = false;

  /**
   * Register an interceptor.
   */
  register(interceptor: ToolInterceptor): void {
    if (this.interceptors.some((existing) => existing.name === interceptor.name)) {
      logger.debug('Skipping duplicate interceptor registration', { name: interceptor.name });
      return;
    }

    this.interceptors.push(interceptor);
    logger.info('Registered interceptor', { name: interceptor.name, tools: interceptor.tools });

    if (this.started) {
      void this.startInterceptor(interceptor);
    }
  }

  private async startInterceptor(interceptor: ToolInterceptor): Promise<void> {
    if (!interceptor.start) {
      return;
    }

    try {
      await interceptor.start();
    } catch (error) {
      logger.error('Interceptor start hook error', {
        interceptor: interceptor.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopInterceptor(interceptor: ToolInterceptor): Promise<void> {
    if (!interceptor.stop) {
      return;
    }

    try {
      await interceptor.stop();
    } catch (error) {
      logger.error('Interceptor stop hook error', {
        interceptor: interceptor.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start all registered interceptors.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    for (const interceptor of this.interceptors) {
      await this.startInterceptor(interceptor);
    }
  }

  /**
   * Stop all registered interceptors.
   */
  async stop(): Promise<void> {
    this.started = false;
    for (const interceptor of this.interceptors) {
      await this.stopInterceptor(interceptor);
    }
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
