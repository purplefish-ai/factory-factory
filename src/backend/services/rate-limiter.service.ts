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
  maxConcurrentEpics: number;

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
  activeEpics: number;
  limits: {
    maxWorkers: number;
    maxSupervisors: number;
    maxEpics: number;
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
    maxConcurrentEpics: Number.parseInt(process.env.MAX_CONCURRENT_EPICS || '5', 10),
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
  private activeEpics = new Set<string>();

  // Processing state
  private isProcessingQueue = false;

  // API usage by agent
  private usageByAgent: Map<string, number> = new Map();
  private usageByEpic: Map<string, number> = new Map();

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
  async acquireSlot(
    agentId: string,
    epicId: string | null,
    priority: RequestPriority = RequestPriority.WORKER
  ): Promise<void> {
    // Check if we can proceed immediately
    if (!this.isRateLimited()) {
      this.recordRequest(agentId, epicId);
      return;
    }

    // Queue the request
    if (this.requestQueue.length >= this.config.maxQueueSize) {
      throw new Error('Rate limit queue is full');
    }

    return new Promise<void>((resolve, reject) => {
      const request: QueuedRequest = {
        id: `${agentId}-${Date.now()}`,
        priority,
        timestamp: Date.now(),
        resolve: () => {
          this.recordRequest(agentId, epicId);
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
  private recordRequest(agentId: string, epicId: string | null): void {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.totalRequests++;

    // Track usage by agent
    this.usageByAgent.set(agentId, (this.usageByAgent.get(agentId) || 0) + 1);

    // Track usage by epic
    if (epicId) {
      this.usageByEpic.set(epicId, (this.usageByEpic.get(epicId) || 0) + 1);
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
   * Register an active epic
   */
  registerEpic(epicId: string): boolean {
    if (this.activeEpics.size >= this.config.maxConcurrentEpics) {
      logger.warn('Max concurrent epics reached', {
        current: this.activeEpics.size,
        max: this.config.maxConcurrentEpics,
      });
      return false;
    }

    this.activeEpics.add(epicId);
    logger.debug('Epic registered', {
      epicId,
      activeEpics: this.activeEpics.size,
    });
    return true;
  }

  /**
   * Unregister an epic
   */
  unregisterEpic(epicId: string): void {
    this.activeEpics.delete(epicId);
    logger.debug('Epic unregistered', {
      epicId,
      activeEpics: this.activeEpics.size,
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
   * Check if we can start a new epic
   */
  canStartEpic(): boolean {
    return this.activeEpics.size < this.config.maxConcurrentEpics;
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
      activeEpics: this.activeEpics.size,
      limits: {
        maxWorkers: this.config.maxConcurrentWorkers,
        maxSupervisors: this.config.maxConcurrentSupervisors,
        maxEpics: this.config.maxConcurrentEpics,
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
   * Get usage by epic
   */
  getUsageByEpic(): Map<string, number> {
    return new Map(this.usageByEpic);
  }

  /**
   * Reset usage statistics
   */
  resetUsageStats(): void {
    this.usageByAgent.clear();
    this.usageByEpic.clear();
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
