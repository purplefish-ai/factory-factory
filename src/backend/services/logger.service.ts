/**
 * Structured Logging Service
 *
 * Provides structured logging with different levels for production readiness.
 * Uses a simple but effective logging format compatible with log aggregation tools.
 *
 * In production mode, logs are written to a file (~/factory-factory/logs/server.log)
 * instead of the console. Only errors are also written to stderr for visibility.
 */

import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

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
interface LoggerConfig {
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
 * Safely stringify an object, handling circular references.
 * Pre-processes with ancestor tracking to replace circular references,
 * invokes toJSON() on objects that define it, then uses JSON.stringify
 * on the safe result.
 */
function safeStringify(obj: unknown): string {
  try {
    const ancestors = new WeakSet<object>();

    function preprocessValue(value: unknown): unknown {
      if (typeof value !== 'object' || value === null) {
        return value;
      }

      // Check for circular reference (ancestor on current path)
      if (ancestors.has(value)) {
        return '[Circular]';
      }

      // If object has toJSON, preprocess its result instead of skipping traversal
      if ('toJSON' in value && typeof (value as Record<string, unknown>).toJSON === 'function') {
        return preprocessValue((value as { toJSON: () => unknown }).toJSON());
      }

      ancestors.add(value);

      try {
        if (Array.isArray(value)) {
          return value.map((item) => preprocessValue(item));
        }

        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          result[key] = preprocessValue(val);
        }
        return result;
      } finally {
        ancestors.delete(value);
      }
    }

    const processed = preprocessValue(obj);
    return JSON.stringify(processed);
  } catch {
    return String(obj);
  }
}

/**
 * Log file support.
 * Logs are always written to a file. In production, the file is the primary
 * output (only errors also go to stderr). In development, logs go to both
 * the console and the file.
 */
let _logFileStream: WriteStream | null = null;
let _logFilePath: string | null = null;

function initLogFileStream(): WriteStream | null {
  try {
    const baseDir = process.env.BASE_DIR || join(homedir(), 'factory-factory');
    const logsDir = join(baseDir, 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    _logFilePath = join(logsDir, 'server.log');
    const stream = createWriteStream(_logFilePath, { flags: 'a' });
    stream.on('error', () => {
      _logFileStream = null;
    });
    return stream;
  } catch {
    return null;
  }
}

function getLogFileStream(): WriteStream | null {
  if (!_logFileStream) {
    _logFileStream = initLogFileStream();
  }
  return _logFileStream;
}

/**
 * Get the path of the log file (for display in startup messages).
 */
export function getLogFilePath(): string {
  if (_logFilePath) {
    return _logFilePath;
  }
  const baseDir = process.env.BASE_DIR || join(homedir(), 'factory-factory');
  return join(baseDir, 'logs', 'server.log');
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
class Logger {
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
        ...context,
        service: this.config.serviceName,
        component: this.component,
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
   * Write an entry to the log file as JSON (used by both output modes).
   */
  private writeToLogFile(entry: LogEntry): void {
    const stream = getLogFileStream();
    if (stream) {
      stream.write(`${safeStringify(entry)}\n`);
    }
  }

  /**
   * Output in JSON format (for production).
   * Writes to the log file, with only errors echoed to stderr.
   */
  private jsonOutput(entry: LogEntry): void {
    this.writeToLogFile(entry);

    // In production, only surface errors in the terminal
    if (entry.level === 'error') {
      console.error(safeStringify(entry));
    }
  }

  /**
   * Output in pretty format (for development).
   * Writes to both the console and the log file.
   */
  private prettyOutput(entry: LogEntry): void {
    this.writeToLogFile(entry);

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
        output += ` ${safeStringify(rest)}`;
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
   * Log top-level task lifecycle events
   */
  topLevelTaskEvent(
    event: 'created' | 'started' | 'completed' | 'cancelled' | 'blocked',
    topLevelTaskId: string,
    context?: Record<string, unknown>
  ): void {
    this.info(`Top-level task ${event}`, {
      event,
      topLevelTaskId,
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

// Export factory function
export function createLogger(component: string): Logger {
  return new Logger(component);
}
