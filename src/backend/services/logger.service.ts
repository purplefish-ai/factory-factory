/**
 * Structured Logging Service
 *
 * Provides structured logging with different levels for production readiness.
 * Uses a simple but effective logging format compatible with log aggregation tools.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: LogLevel;
  prettyPrint: boolean;
  includeTimestamp: boolean;
  serviceName: string;
}

/**
 * Get log level priority (lower = more severe)
 */
function getLogLevelPriority(level: LogLevel): number {
  const priorities: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  return priorities[level];
}

/**
 * Get default configuration from environment
 */
function getDefaultConfig(): LoggerConfig {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  const validLevels: LogLevel[] = ['error', 'warn', 'info', 'debug'];

  return {
    level: validLevels.includes(envLevel as LogLevel) ? (envLevel as LogLevel) : 'info',
    prettyPrint: process.env.NODE_ENV !== 'production',
    includeTimestamp: true,
    serviceName: process.env.SERVICE_NAME || 'factoryfactory',
  };
}

/**
 * Logger class for structured logging
 */
export class Logger {
  private config: LoggerConfig;
  private component: string;

  constructor(component: string, config?: Partial<LoggerConfig>) {
    this.component = component;
    this.config = {
      ...getDefaultConfig(),
      ...config,
    };
  }

  /**
   * Create a child logger with additional context
   */
  child(component: string): Logger {
    return new Logger(`${this.component}:${component}`, this.config);
  }

  /**
   * Check if a log level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return getLogLevelPriority(level) <= getLogLevelPriority(this.config.level);
  }

  /**
   * Format and output a log entry
   */
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      timestamp: this.config.includeTimestamp ? new Date().toISOString() : '',
      message,
      context: {
        service: this.config.serviceName,
        component: this.component,
        ...context,
      },
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    if (this.config.prettyPrint) {
      this.prettyOutput(entry);
    } else {
      this.jsonOutput(entry);
    }
  }

  /**
   * Output in JSON format (for production log aggregation)
   */
  private jsonOutput(entry: LogEntry): void {
    const output = JSON.stringify(entry);
    if (entry.level === 'error') {
      console.error(output);
    } else if (entry.level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  /**
   * Output in pretty format (for development)
   */
  private prettyOutput(entry: LogEntry): void {
    const levelColors: Record<LogLevel, string> = {
      error: '\x1b[31m', // Red
      warn: '\x1b[33m', // Yellow
      info: '\x1b[36m', // Cyan
      debug: '\x1b[37m', // White
    };
    const reset = '\x1b[0m';
    const color = levelColors[entry.level];

    let output = `${color}[${entry.level.toUpperCase()}]${reset}`;
    if (entry.timestamp) {
      output += ` ${entry.timestamp}`;
    }
    output += ` [${this.component}] ${entry.message}`;

    if (entry.context && Object.keys(entry.context).length > 2) {
      // More than just service and component - extract additional context
      const { service: _service, component: _component, ...rest } = entry.context;
      if (Object.keys(rest).length > 0) {
        output += ` ${JSON.stringify(rest)}`;
      }
    }

    if (entry.level === 'error') {
      console.error(output);
      if (entry.error?.stack) {
        console.error(entry.error.stack);
      }
    } else if (entry.level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  /**
   * Log an error message
   */
  error(message: string, context?: Record<string, unknown>): void;
  error(message: string, error: Error, context?: Record<string, unknown>): void;
  error(
    message: string,
    errorOrContext?: Error | Record<string, unknown>,
    context?: Record<string, unknown>
  ): void {
    if (errorOrContext instanceof Error) {
      this.log('error', message, context, errorOrContext);
    } else {
      this.log('error', message, errorOrContext);
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  /**
   * Log an info message
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  /**
   * Log agent lifecycle events
   */
  agentEvent(
    event: 'created' | 'started' | 'stopped' | 'crashed' | 'recovered' | 'completed',
    agentId: string,
    agentType: string,
    context?: Record<string, unknown>
  ): void {
    this.info(`Agent ${event}`, {
      event,
      agentId,
      agentType,
      ...context,
    });
  }

  /**
   * Log task lifecycle events
   */
  taskEvent(
    event: 'created' | 'assigned' | 'started' | 'completed' | 'failed' | 'blocked',
    taskId: string,
    context?: Record<string, unknown>
  ): void {
    this.info(`Task ${event}`, {
      event,
      taskId,
      ...context,
    });
  }

  /**
   * Log epic lifecycle events
   */
  epicEvent(
    event: 'created' | 'started' | 'completed' | 'cancelled' | 'blocked',
    epicId: string,
    context?: Record<string, unknown>
  ): void {
    this.info(`Epic ${event}`, {
      event,
      epicId,
      ...context,
    });
  }

  /**
   * Log API calls
   */
  apiCall(
    service: string,
    method: string,
    duration: number,
    success: boolean,
    context?: Record<string, unknown>
  ): void {
    this.info(`API call ${success ? 'succeeded' : 'failed'}`, {
      service,
      method,
      duration,
      success,
      ...context,
    });
  }
}

// Create root logger
const rootLogger = new Logger('root');

// Export factory function and singleton
export function createLogger(component: string): Logger {
  return new Logger(component);
}

export const logger = rootLogger;
