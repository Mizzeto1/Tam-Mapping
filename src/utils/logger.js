/**
 * Production Logger
 *
 * Provides structured JSON logging for production environments.
 * In development, uses human-readable console output.
 *
 * Log levels: error, warn, info, debug
 */

import config from '../config/index.js';

// Log level hierarchy
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Current log level from config
const currentLevel = LOG_LEVELS[config.logging?.level] ?? LOG_LEVELS.info;

/**
 * Format a log entry
 * - Production: JSON format for log aggregation
 * - Development: Human-readable console output
 */
function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();

  if (config.isProd) {
    // Structured JSON for production (Railway, Datadog, etc.)
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...meta,
      env: config.env,
    });
  }

  // Human-readable for development
  const levelIcons = {
    error: '❌',
    warn: '⚠️',
    info: 'ℹ️',
    debug: '🔍',
  };

  const icon = levelIcons[level] || '📝';
  const metaStr = Object.keys(meta).length > 0
    ? ` ${JSON.stringify(meta)}`
    : '';

  return `${icon} [${level.toUpperCase()}] ${message}${metaStr}`;
}

/**
 * Check if a log level should be output
 */
function shouldLog(level) {
  return LOG_LEVELS[level] <= currentLevel;
}

/**
 * Log an error message
 * @param {string} message - Log message
 * @param {object} meta - Additional metadata
 */
export function error(message, meta = {}) {
  if (shouldLog('error')) {
    console.error(formatLog('error', message, meta));
  }
}

/**
 * Log a warning message
 * @param {string} message - Log message
 * @param {object} meta - Additional metadata
 */
export function warn(message, meta = {}) {
  if (shouldLog('warn')) {
    console.warn(formatLog('warn', message, meta));
  }
}

/**
 * Log an info message
 * @param {string} message - Log message
 * @param {object} meta - Additional metadata
 */
export function info(message, meta = {}) {
  if (shouldLog('info')) {
    console.log(formatLog('info', message, meta));
  }
}

/**
 * Log a debug message
 * @param {string} message - Log message
 * @param {object} meta - Additional metadata
 */
export function debug(message, meta = {}) {
  if (shouldLog('debug')) {
    console.log(formatLog('debug', message, meta));
  }
}

/**
 * Log the start of an operation (for timing)
 * @param {string} operation - Operation name
 * @returns {function} - Call to log completion with duration
 */
export function startTimer(operation) {
  const startTime = Date.now();
  info(`${operation} started`);

  return (success = true, meta = {}) => {
    const duration = Date.now() - startTime;
    const level = success ? 'info' : 'error';
    const status = success ? 'completed' : 'failed';

    if (level === 'error') {
      error(`${operation} ${status}`, { duration_ms: duration, ...meta });
    } else {
      info(`${operation} ${status}`, { duration_ms: duration, ...meta });
    }

    return duration;
  };
}

/**
 * Create a child logger with preset metadata
 * @param {object} defaultMeta - Default metadata for all logs
 */
export function child(defaultMeta = {}) {
  return {
    error: (msg, meta = {}) => error(msg, { ...defaultMeta, ...meta }),
    warn: (msg, meta = {}) => warn(msg, { ...defaultMeta, ...meta }),
    info: (msg, meta = {}) => info(msg, { ...defaultMeta, ...meta }),
    debug: (msg, meta = {}) => debug(msg, { ...defaultMeta, ...meta }),
    startTimer: (op) => startTimer(op),
  };
}

export default {
  error,
  warn,
  info,
  debug,
  startTimer,
  child,
  LOG_LEVELS,
};
