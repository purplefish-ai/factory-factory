/**
 * Rate Limiter Service
 *
 * Provides rate limiting for Claude API calls.
 * Implements token bucket algorithm for API rate limiting.
 */

import { configService, type RateLimiterConfig } from './config.service';
import { createLogger } from './logger.service';

const logger = createLogger('rate-limiter');

/**
 * Request priority levels
 */
enum RequestPriority {
  HIGH = 0,
  NORMAL = 1,
  LOW = 2,
}

/**
 * Queued request
 */
interface QueuedRequest {
  id: string;
  priority: RequestPriority;
  timestamp: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * API usage statistics
 */
export interface ApiUsageStats {
  requestsLastMinute: number;
  requestsLastHour: number;
  totalRequests: number;
  queueDepth: number;
  isRateLimited: boolean;
}

/**
 * Get default configuration from centralized config service
 */
function getDefaultConfig(): RateLimiterConfig {
  return configService.getRateLimiterConfig();
}

/**
 * Rate Limiter class for managing API rate limits
 */
class RateLimiter {
  private config: RateLimiterConfig;

  // Request tracking
  private requestTimestamps: number[] = [];
  private totalRequests = 0;

  // Request queue (priority queue)
  private requestQueue: QueuedRequest[] = [];

  // Processing state
  private isProcessingQueue = false;

  // API usage by agent
  private usageByAgent: Map<string, number> = new Map();
  private usageByTopLevelTask: Map<string, number> = new Map();

  // Lifecycle management
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private pendingTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private queueProcessingTimeout: NodeJS.Timeout | null = null;
  private queueProcessingResolve: (() => void) | null = null;
  private queueProcessingPromise: Promise<void> | null = null;

  // Request ID counter for unique IDs
  private requestIdCounter = 0;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      ...getDefaultConfig(),
      ...config,
    };
  }

  /**
   * Start the rate limiter service
   */
  start(): void {
    if (this.cleanupInterval) {
      return;
    }
    this.isShuttingDown = false;
    this.isProcessingQueue = false;
    this.cleanupInterval = setInterval(() => {
      if (!this.isShuttingDown) {
        this.cleanupOldTimestamps();
      }
    }, 60_000);
    logger.info('Rate limiter started');
  }

  /**
   * Clean up old request timestamps
   */
  private cleanupOldTimestamps(): void {
    const oneHourAgo = Date.now() - 3_600_000;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > oneHourAgo);
  }

  /**
   * Get requests in the last N milliseconds
   */
  private getRequestsInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.requestTimestamps.filter((ts) => ts > cutoff).length;
  }

  /**
   * Check if rate limited
   */
  isRateLimited(): boolean {
    const requestsLastMinute = this.getRequestsInWindow(60_000);
    const requestsLastHour = this.getRequestsInWindow(3_600_000);

    return (
      requestsLastMinute >= this.config.claudeRequestsPerMinute ||
      requestsLastHour >= this.config.claudeRequestsPerHour
    );
  }

  /**
   * Acquire a rate limit slot for an API request
   * Returns a promise that resolves when the request can proceed
   */
  acquireSlot(
    agentId: string,
    topLevelTaskId: string | null,
    priority: RequestPriority = RequestPriority.NORMAL
  ): Promise<void> {
    // Check if we can proceed immediately
    if (!this.isRateLimited()) {
      this.recordRequest(agentId, topLevelTaskId);
      return Promise.resolve();
    }

    // Queue the request
    if (this.requestQueue.length >= this.config.maxQueueSize) {
      return Promise.reject(new Error('Rate limit queue is full'));
    }

    return new Promise<void>((resolve, reject) => {
      const requestId = `${agentId}-${++this.requestIdCounter}`;
      const request: QueuedRequest = {
        id: requestId,
        priority,
        timestamp: Date.now(),
        resolve: () => {
          // Clear the timeout when request resolves
          const timeout = this.pendingTimeouts.get(requestId);
          if (timeout) {
            clearTimeout(timeout);
            this.pendingTimeouts.delete(requestId);
          }
          this.recordRequest(agentId, topLevelTaskId);
          resolve();
        },
        reject,
      };

      // Insert in priority order
      const insertIndex = this.requestQueue.findIndex((r) => r.priority > priority);
      if (insertIndex === -1) {
        this.requestQueue.push(request);
      } else {
        this.requestQueue.splice(insertIndex, 0, request);
      }

      logger.debug('Request queued', {
        agentId,
        priority,
        queueDepth: this.requestQueue.length,
      });

      // Start queue processing if not already running
      if (!this.queueProcessingPromise) {
        this.queueProcessingPromise = this.processQueue().finally(() => {
          this.queueProcessingPromise = null;
        });
      }

      // Set timeout and track it
      const timeoutId = setTimeout(() => {
        this.pendingTimeouts.delete(requestId);
        const index = this.requestQueue.findIndex((r) => r.id === request.id);
        if (index !== -1) {
          this.requestQueue.splice(index, 1);
          reject(new Error('Rate limit queue timeout'));
        }
      }, this.config.queueTimeoutMs);
      this.pendingTimeouts.set(requestId, timeoutId);
    });
  }

  /**
   * Record a successful request
   */
  private recordRequest(agentId: string, topLevelTaskId: string | null): void {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.totalRequests++;

    // Track usage by agent
    this.usageByAgent.set(agentId, (this.usageByAgent.get(agentId) || 0) + 1);

    // Track usage by top-level task
    if (topLevelTaskId) {
      this.usageByTopLevelTask.set(
        topLevelTaskId,
        (this.usageByTopLevelTask.get(topLevelTaskId) || 0) + 1
      );
    }
  }

  /**
   * Process the request queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.isShuttingDown) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0 && !this.isShuttingDown) {
      if (this.isRateLimited()) {
        // Wait until we can make another request, tracking the timeout for cleanup
        await new Promise<void>((resolve) => {
          this.queueProcessingResolve = resolve;
          this.queueProcessingTimeout = setTimeout(() => {
            this.queueProcessingTimeout = null;
            this.queueProcessingResolve = null;
            resolve();
          }, 1000);
        });
        // Check shutdown flag after waking up
        if (this.isShuttingDown) {
          break;
        }
        continue;
      }

      const request = this.requestQueue.shift();
      if (request) {
        request.resolve();
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Get API usage statistics
   */
  getApiUsageStats(): ApiUsageStats {
    return {
      requestsLastMinute: this.getRequestsInWindow(60_000),
      requestsLastHour: this.getRequestsInWindow(3_600_000),
      totalRequests: this.totalRequests,
      queueDepth: this.requestQueue.length,
      isRateLimited: this.isRateLimited(),
    };
  }

  /**
   * Get usage by agent
   */
  getUsageByAgent(): Map<string, number> {
    return new Map(this.usageByAgent);
  }

  /**
   * Get usage by top-level task
   */
  getUsageByTopLevelTask(): Map<string, number> {
    return new Map(this.usageByTopLevelTask);
  }

  /**
   * Reset usage statistics
   */
  resetUsageStats(): void {
    this.usageByAgent.clear();
    this.usageByTopLevelTask.clear();
    this.totalRequests = 0;
  }

  /**
   * Stop the rate limiter and clean up resources
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear queue processing timeout and resolve its Promise to unblock processQueue
    if (this.queueProcessingTimeout) {
      clearTimeout(this.queueProcessingTimeout);
      this.queueProcessingTimeout = null;
    }
    if (this.queueProcessingResolve) {
      this.queueProcessingResolve();
      this.queueProcessingResolve = null;
    }

    // Wait for in-flight queue processing to complete
    if (this.queueProcessingPromise) {
      logger.debug('Waiting for in-flight queue processing to complete');
      await this.queueProcessingPromise;
    }

    // Clear all pending timeouts
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();

    // Reject all queued requests
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      request?.reject(new Error('Rate limiter shutting down'));
    }

    logger.info('Rate limiter stopped');
  }

  /**
   * Get current configuration
   */
  getConfig(): RateLimiterConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RateLimiterConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    logger.info('Rate limiter configuration updated', { config: this.config });
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiter();
