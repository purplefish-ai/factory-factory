/**
 * Structured Logging Service
 *
 * Provides structured logging with different levels for production readiness.
 * Uses a simple but effective logging format compatible with log aggregation tools.
 *
 * In production mode, logs are written to a file (~/factory-factory/logs/server.log)
 * instead of the console. Only errors are also written to stderr for visibility.
 * The file rotates at 10 MB, keeping three older files; test processes do not
 * write it (see "Log file support" below).
 */

import { appendFileSync, mkdirSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandEnvVars } from '@/backend/lib/env';
import { pruneRotatedLogFiles, RotatingLogFile } from '@/backend/lib/rotating-log-file';
import { LoggerEnvSchema } from './env-schemas';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  context?: Record<string, unknown>;
  // Serialized by safeStringify, which keeps the cause chain and own fields.
  error?: Error;
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
type LoggerEnv = ReturnType<typeof LoggerEnvSchema.parse>;

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
 * invokes toJSON() on objects that define it, expands Errors and converts
 * BigInts to strings, then uses JSON.stringify on the safe result.
 */
function safeStringify(obj: unknown): string {
  const ancestors = new WeakSet<object>();

  function tryToJSON(value: object): { ok: true; result: unknown } | { ok: false } {
    if (!('toJSON' in value) || typeof (value as Record<string, unknown>).toJSON !== 'function') {
      return { ok: false };
    }
    try {
      return { ok: true, result: (value as { toJSON: () => unknown }).toJSON() };
    } catch {
      return { ok: false };
    }
  }

  function traverseObject(value: object): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = preprocessValue(val);
    }
    return result;
  }

  // Error name, message, stack, cause and AggregateError errors are not
  // enumerable, so traversing own entries alone would serialize an Error as {}.
  function serializeError(error: Error): Record<string, unknown> {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause === undefined ? {} : { cause: preprocessValue(error.cause) }),
      ...(error instanceof AggregateError ? { errors: preprocessValue(error.errors) } : {}),
      ...traverseObject(error),
    };
  }

  function preprocessObject(value: object): unknown {
    const toJson = tryToJSON(value);
    if (toJson.ok) {
      return preprocessValue(toJson.result);
    }
    if (value instanceof Error) {
      return serializeError(value);
    }
    return Array.isArray(value)
      ? value.map((item) => preprocessValue(item))
      : traverseObject(value);
  }

  function preprocessValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'function' || typeof value !== 'object' || value === null) {
      return typeof value === 'function' ? undefined : value;
    }
    if (ancestors.has(value)) {
      return '[Circular]';
    }

    ancestors.add(value);
    try {
      return preprocessObject(value);
    } finally {
      ancestors.delete(value);
    }
  }

  try {
    return JSON.stringify(preprocessValue(obj));
  } catch (err) {
    return JSON.stringify({ __serializationError: err instanceof Error ? err.message : 'unknown' });
  }
}

/**
 * Log file support.
 * Logs are written to `<BASE_DIR>/logs/server.log`. In production, the file is
 * the primary output (only errors also go to stderr). In development, logs go
 * to both the console and the file. The file rotates by size; see
 * RotatingLogFile for the mechanics.
 *
 * Test processes (NODE_ENV=test, or anything Vitest started) never write to the
 * default log: they get a file only when BASE_DIR explicitly points inside the
 * OS temp directory. Otherwise ordinary records go to the console only and
 * fatal records use the stderr fallback.
 */
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES = 3;
const DEFAULT_LOG_RETENTION_DAYS = 7;

let _logFile: RotatingLogFile | null = null;

function parseLoggerEnv(): LoggerEnv {
  return LoggerEnvSchema.parse(process.env);
}

export function getCurrentProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function resolveBaseDir(env: LoggerEnv): string {
  return env.BASE_DIR ? expandEnvVars(env.BASE_DIR) : join(homedir(), 'factory-factory');
}

function resolveLogFilePath(env: LoggerEnv): string {
  return join(resolveBaseDir(env), 'logs', 'server.log');
}

function isInsideTempDir(path: string): boolean {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/**
 * The file the sink may write to, or null when this process must not write a
 * log file. Re-evaluated until a sink opens, so tests can opt in per test.
 */
function resolveWritableLogFilePath(): string | null {
  const env = parseLoggerEnv();
  const isTestProcess = env.NODE_ENV === 'test' || env.VITEST !== undefined;
  if (isTestProcess && !(env.BASE_DIR && isInsideTempDir(resolveBaseDir(env)))) {
    return null;
  }
  return resolveLogFilePath(env);
}

function getLogFile(): RotatingLogFile | null {
  if (!_logFile) {
    const path = resolveWritableLogFilePath();
    _logFile = path
      ? new RotatingLogFile({
          path,
          maxBytes: MAX_LOG_FILE_BYTES,
          maxRotatedFiles: MAX_ROTATED_LOG_FILES,
        })
      : null;
  }
  return _logFile;
}

/**
 * Get the path of the current log file (for display and the admin log viewer).
 * Rotated history lives beside it as `server.log.1` (newest) onwards.
 */
export function getLogFilePath(): string {
  return _logFile?.path ?? resolveLogFilePath(parseLoggerEnv());
}

/**
 * Delete rotated server logs older than maxAgeDays. Runs at backend startup
 * beside the session and ACP trace log cleanups; the current file is kept.
 */
export async function cleanupOldLogFiles(
  maxAgeDays: number = DEFAULT_LOG_RETENTION_DAYS
): Promise<number> {
  const path = _logFile?.path ?? resolveWritableLogFilePath();
  if (!path) {
    return 0;
  }
  return await pruneRotatedLogFiles(
    path,
    MAX_ROTATED_LOG_FILES,
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  );
}

/**
 * Get default configuration from environment
 */
function getDefaultConfig(): LoggerConfig {
  const env = parseLoggerEnv();

  return {
    level: env.LOG_LEVEL,
    prettyPrint: env.NODE_ENV !== 'production',
    includeTimestamp: true,
    serviceName: env.SERVICE_NAME,
  };
}

// Keep sink state on the stream so module reloads share one error listener and
// cannot revive a failed sink. Never report a sink failure through the logger.
const consoleSinkStateKey = Symbol.for('factory-factory.logger.console-sink-state');
interface ConsoleSinkState {
  failed: boolean;
}
type ConsoleStream = NodeJS.WriteStream & { [consoleSinkStateKey]?: ConsoleSinkState };

function writeToConsole(stream: ConsoleStream, write: () => void): void {
  let state = stream[consoleSinkStateKey];
  if (!state) {
    const registeredState = { failed: false };
    stream[consoleSinkStateKey] = registeredState;
    stream.on('error', () => {
      registeredState.failed = true;
    });
    state = registeredState;
  }
  if (state.failed) {
    return;
  }
  try {
    write();
  } catch {
    state.failed = true;
  }
}

// Never route this fallback through the logger or retry a broken pipe.
function writeFatalRecordToStderr(record: string): void {
  try {
    const bytes = Buffer.from(record);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(2, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        break;
      }
      offset += written;
    }
  } catch {
    // Both terminal sinks are unavailable; shutdown must still proceed.
  }
}

// The terminal record must survive an immediate process.exit, even when
// ordinary asynchronous file writes are still queued, so append synchronously
// to the current file (bypassing the stream and its rotation).
function writeFatalRecord(record: string): void {
  const path = _logFile?.path ?? resolveWritableLogFilePath();
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, record);
      return;
    } catch {
      // Fall through to stderr.
    }
  }
  writeFatalRecordToStderr(record);
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
    error?: Error,
    fatal = false
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
      entry.error = error;
    }

    if (fatal) {
      writeFatalRecord(`${safeStringify(entry)}\n`);
    } else if (this.config.prettyPrint) {
      this.prettyOutput(entry);
    } else {
      this.jsonOutput(entry);
    }
  }

  /**
   * Write an entry to the log file as JSON (used by both output modes).
   */
  private writeToLogFile(entry: LogEntry): void {
    getLogFile()?.write(`${safeStringify(entry)}\n`);
  }

  /**
   * Output in JSON format (for production).
   * Writes to the log file, with only errors echoed to stderr.
   */
  private jsonOutput(entry: LogEntry): void {
    this.writeToLogFile(entry);

    // In production, only surface errors in the terminal
    if (entry.level === 'error') {
      writeToConsole(process.stderr, () => console.error(safeStringify(entry)));
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
      writeToConsole(process.stderr, () => {
        console.error(output);
        if (entry.error?.stack) {
          console.error(entry.error.stack);
        }
      });
    } else if (entry.level === 'warn') {
      writeToConsole(process.stderr, () => console.warn(output));
    } else {
      writeToConsole(process.stdout, () => console.log(output));
    }
  }

  /**
   * Write one terminal record synchronously, falling back to stderr if the file fails.
   */
  fatal(message: string, errorOrContext?: Error | Record<string, unknown>): void {
    this.log(
      'error',
      message,
      errorOrContext instanceof Error ? undefined : errorOrContext,
      errorOrContext instanceof Error ? errorOrContext : undefined,
      true
    );
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
}

// Export factory function
export function createLogger(component: string): Logger {
  return new Logger(component);
}
