/**
 * Resource monitoring for Claude CLI processes.
 *
 * Tracks CPU/memory usage and detects hung processes.
 */

import { EventEmitter } from 'node:events';
import pidusage from 'pidusage';
import { configService } from '../services/config.service';
import { createLogger } from '../services/logger.service';
import type { ResourceUsage } from './types/process-types';

const logger = createLogger('claude-process-monitor');

/**
 * Options for resource monitoring.
 */
export interface ResourceMonitoringOptions {
  /** Enable resource monitoring (default: true) */
  enabled?: boolean;
  /** Maximum memory in bytes before killing process (default: 2GB) */
  maxMemoryBytes?: number;
  /** Maximum CPU percentage to warn about (default: 90%) */
  maxCpuPercent?: number;
  /** Time in ms without activity before considering process hung (default: 30 minutes) */
  activityTimeoutMs?: number;
  /** Time in ms before timeout to emit a warning (default: 80% of activityTimeoutMs) */
  hungWarningThresholdMs?: number;
  /** Interval in ms between resource checks (default: 5 seconds) */
  monitoringIntervalMs?: number;
}

export interface MonitorTarget {
  getPid(): number | undefined;
  isRunning(): boolean;
  kill(): void;
}

export interface MonitorEvents {
  resource_exceeded: (data: { type: 'memory' | 'cpu'; value: number }) => void;
  hung_warning: (data: { lastActivity: number; idleTimeMs: number; timeoutMs: number }) => void;
  hung_process: (data: { lastActivity: number }) => void;
  resource_usage: (usage: ResourceUsage) => void;
}

export class ClaudeProcessMonitor extends EventEmitter {
  private target: MonitorTarget;
  private options: Required<ResourceMonitoringOptions>;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private lastActivityAt: number = Date.now();
  private lastResourceUsage: ResourceUsage | null = null;
  private hungWarningEmitted = false;

  constructor(target: MonitorTarget, options?: ResourceMonitoringOptions) {
    super();
    this.target = target;
    this.options = {
      ...ClaudeProcessMonitor.buildDefaultMonitoring(),
      ...options,
    };
  }

  static buildDefaultMonitoring(): Required<ResourceMonitoringOptions> {
    const activityTimeoutMs = configService.getClaudeProcessConfig().hungTimeoutMs;
    return {
      enabled: true,
      maxMemoryBytes: 5 * 1024 * 1024 * 1024, // 5GB
      maxCpuPercent: 90,
      activityTimeoutMs,
      hungWarningThresholdMs: Math.floor(activityTimeoutMs * 0.8),
      monitoringIntervalMs: 5000,
    };
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  start(): void {
    if (!this.options.enabled || this.monitoringInterval) {
      return;
    }

    const { monitoringIntervalMs } = this.options;
    this.monitoringInterval = setInterval(async () => {
      await this.performResourceCheck();
    }, monitoringIntervalMs);
  }

  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  recordActivity(): void {
    this.lastActivityAt = Date.now();
    this.hungWarningEmitted = false;
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  getIdleTimeMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  getResourceUsage(): ResourceUsage | null {
    return this.lastResourceUsage;
  }

  private async performResourceCheck(): Promise<void> {
    const pid = this.target.getPid();
    if (!(pid && this.target.isRunning())) {
      this.stop();
      return;
    }

    try {
      const usage = await pidusage(pid);
      this.updateResourceUsage(usage, pid);
      this.checkIdleTime(pid);
    } catch (error) {
      logger.debug('Failed to get resource usage, stopping monitoring', {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
      this.stop();
    }
  }

  private updateResourceUsage(usage: { cpu: number; memory: number }, pid: number): void {
    const { maxMemoryBytes, maxCpuPercent } = this.options;

    const resourceUsage: ResourceUsage = {
      cpu: usage.cpu,
      memory: usage.memory,
      timestamp: new Date(),
    };
    this.lastResourceUsage = resourceUsage;
    this.emit('resource_usage', resourceUsage);

    if (usage.memory > maxMemoryBytes) {
      logger.warn('Process exceeded memory threshold, killing', {
        pid,
        memoryBytes: usage.memory,
        maxMemoryBytes,
      });
      this.emit('resource_exceeded', { type: 'memory', value: usage.memory });
      this.target.kill();
      return;
    }

    if (usage.cpu > maxCpuPercent) {
      this.emit('resource_exceeded', { type: 'cpu', value: usage.cpu });
    }
  }

  private checkIdleTime(pid: number): void {
    const { activityTimeoutMs, hungWarningThresholdMs } = this.options;
    const idleTime = Date.now() - this.lastActivityAt;

    if (idleTime > hungWarningThresholdMs && !this.hungWarningEmitted) {
      logger.warn('Process approaching hung timeout', {
        pid,
        idleTimeMs: idleTime,
        warningThresholdMs: hungWarningThresholdMs,
        timeoutMs: activityTimeoutMs,
      });
      this.hungWarningEmitted = true;
      this.emit('hung_warning', {
        lastActivity: this.lastActivityAt,
        idleTimeMs: idleTime,
        timeoutMs: activityTimeoutMs,
      });
    }

    if (idleTime > activityTimeoutMs) {
      logger.warn('Process exceeded activity timeout, killing', {
        pid,
        idleTimeMs: idleTime,
        activityTimeoutMs,
      });
      this.emit('hung_process', { lastActivity: this.lastActivityAt });
      this.target.kill();
    }
  }

  // =========================================================================
  // Event Emitter Overloads (for TypeScript)
  // =========================================================================

  override on<K extends keyof MonitorEvents>(event: K, handler: MonitorEvents[K]): this;
  override on(event: string, handler: (...args: unknown[]) => void): this {
    return super.on(event, handler);
  }

  override emit<K extends keyof MonitorEvents>(
    event: K,
    ...args: Parameters<MonitorEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}
