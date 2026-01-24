/**
 * Rate Limiter Service
 *
 * Provides rate limiting for Claude API calls and agent concurrency management.
 * Implements token bucket algorithm for API rate limiting.
 */

import { createLogger } from './logger.service.js';

const logger = createLogger('rate-limiter');

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  // Claude API rate limits
  claudeRequestsPerMinute: number;
  claudeRequestsPerHour: number;

  // Concurrency limits
  maxConcurrentWorkers: number;
  maxConcurrentSupervisors: number;
  maxConcurrentTopLevelTasks: number;

  // Queue settings
  maxQueueSize: number;
  queueTimeoutMs: number;
}

/**
 * Request priority levels
 */
export enum RequestPriority {
  ORCHESTRATOR = 0, // Highest priority
  SUPERVISOR = 1,
  WORKER = 2, // Lowest priority
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
 * Concurrency statistics
 */
export interface ConcurrencyStats {
  activeWorkers: number;
  activeSupervisors: number;
  activeTopLevelTasks: number;
  limits: {
    maxWorkers: number;
    maxSupervisors: number;
    maxTopLevelTasks: number;
  };
}

/**
 * Get default configuration from environment
 */
function getDefaultConfig(): RateLimiterConfig {
  return {
    claudeRequestsPerMinute: Number.parseInt(process.env.CLAUDE_RATE_LIMIT_PER_MINUTE || '60', 10),
    claudeRequestsPerHour: Number.parseInt(process.env.CLAUDE_RATE_LIMIT_PER_HOUR || '1000', 10),
    maxConcurrentWorkers: Number.parseInt(process.env.MAX_CONCURRENT_WORKERS || '10', 10),
    maxConcurrentSupervisors: Number.parseInt(process.env.MAX_CONCURRENT_SUPERVISORS || '5', 10),
    maxConcurrentTopLevelTasks: Number.parseInt(
      process.env.MAX_CONCURRENT_TOP_LEVEL_TASKS || '5',
      10
    ),
    maxQueueSize: Number.parseInt(process.env.RATE_LIMIT_QUEUE_SIZE || '100', 10),
    queueTimeoutMs: Number.parseInt(process.env.RATE_LIMIT_QUEUE_TIMEOUT_MS || '30000', 10),
  };
}

/**
 * Rate Limiter class for managing API and concurrency limits
 */
export class RateLimiter {
  private config: RateLimiterConfig;

  // Request tracking
  private requestTimestamps: number[] = [];
  private totalRequests = 0;

  // Request queue (priority queue)
  private requestQueue: QueuedRequest[] = [];

  // Active agent tracking
  private activeWorkers = new Set<string>();
  private activeSupervisors = new Set<string>();
  private activeTopLevelTasks = new Set<string>();

  // Processing state
  private isProcessingQueue = false;

  // API usage by agent
  private usageByAgent: Map<string, number> = new Map();
  private usageByTopLevelTask: Map<string, number> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      ...getDefaultConfig(),
      ...config,
    };

    // Clean up old timestamps periodically
    setInterval(() => this.cleanupOldTimestamps(), 60_000);
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
    priority: RequestPriority = RequestPriority.WORKER
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
      const request: QueuedRequest = {
        id: `${agentId}-${Date.now()}`,
        priority,
        timestamp: Date.now(),
        resolve: () => {
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
      this.processQueue();

      // Set timeout
      setTimeout(() => {
        const index = this.requestQueue.findIndex((r) => r.id === request.id);
        if (index !== -1) {
          this.requestQueue.splice(index, 1);
          reject(new Error('Rate limit queue timeout'));
        }
      }, this.config.queueTimeoutMs);
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
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      if (this.isRateLimited()) {
        // Wait until we can make another request
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
   * Register an active worker
   */
  registerWorker(workerId: string): boolean {
    if (this.activeWorkers.size >= this.config.maxConcurrentWorkers) {
      logger.warn('Max concurrent workers reached', {
        current: this.activeWorkers.size,
        max: this.config.maxConcurrentWorkers,
      });
      return false;
    }

    this.activeWorkers.add(workerId);
    logger.debug('Worker registered', {
      workerId,
      activeWorkers: this.activeWorkers.size,
    });
    return true;
  }

  /**
   * Unregister a worker
   */
  unregisterWorker(workerId: string): void {
    this.activeWorkers.delete(workerId);
    logger.debug('Worker unregistered', {
      workerId,
      activeWorkers: this.activeWorkers.size,
    });
  }

  /**
   * Register an active supervisor
   */
  registerSupervisor(supervisorId: string): boolean {
    if (this.activeSupervisors.size >= this.config.maxConcurrentSupervisors) {
      logger.warn('Max concurrent supervisors reached', {
        current: this.activeSupervisors.size,
        max: this.config.maxConcurrentSupervisors,
      });
      return false;
    }

    this.activeSupervisors.add(supervisorId);
    logger.debug('Supervisor registered', {
      supervisorId,
      activeSupervisors: this.activeSupervisors.size,
    });
    return true;
  }

  /**
   * Unregister a supervisor
   */
  unregisterSupervisor(supervisorId: string): void {
    this.activeSupervisors.delete(supervisorId);
    logger.debug('Supervisor unregistered', {
      supervisorId,
      activeSupervisors: this.activeSupervisors.size,
    });
  }

  /**
   * Register an active top-level task
   */
  registerTopLevelTask(topLevelTaskId: string): boolean {
    if (this.activeTopLevelTasks.size >= this.config.maxConcurrentTopLevelTasks) {
      logger.warn('Max concurrent top-level tasks reached', {
        current: this.activeTopLevelTasks.size,
        max: this.config.maxConcurrentTopLevelTasks,
      });
      return false;
    }

    this.activeTopLevelTasks.add(topLevelTaskId);
    logger.debug('Top-level task registered', {
      topLevelTaskId,
      activeTopLevelTasks: this.activeTopLevelTasks.size,
    });
    return true;
  }

  /**
   * Unregister a top-level task
   */
  unregisterTopLevelTask(topLevelTaskId: string): void {
    this.activeTopLevelTasks.delete(topLevelTaskId);
    logger.debug('Top-level task unregistered', {
      topLevelTaskId,
      activeTopLevelTasks: this.activeTopLevelTasks.size,
    });
  }

  /**
   * Check if we can start a new worker
   */
  canStartWorker(): boolean {
    return this.activeWorkers.size < this.config.maxConcurrentWorkers;
  }

  /**
   * Check if we can start a new supervisor
   */
  canStartSupervisor(): boolean {
    return this.activeSupervisors.size < this.config.maxConcurrentSupervisors;
  }

  /**
   * Check if we can start a new top-level task
   */
  canStartTopLevelTask(): boolean {
    return this.activeTopLevelTasks.size < this.config.maxConcurrentTopLevelTasks;
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
   * Get concurrency statistics
   */
  getConcurrencyStats(): ConcurrencyStats {
    return {
      activeWorkers: this.activeWorkers.size,
      activeSupervisors: this.activeSupervisors.size,
      activeTopLevelTasks: this.activeTopLevelTasks.size,
      limits: {
        maxWorkers: this.config.maxConcurrentWorkers,
        maxSupervisors: this.config.maxConcurrentSupervisors,
        maxTopLevelTasks: this.config.maxConcurrentTopLevelTasks,
      },
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
