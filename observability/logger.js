/**
 * logger.js
 *
 * Minimal structured logger for the ML Signal Engine backend.
 *
 * Output: newline-delimited JSON to stdout (info/debug) or stderr (warn/error).
 * Each line: { level, message, timestamp, ...extra }
 *
 * Usage:
 *   import { logger } from '../observability/logger.js';
 *   logger.info('Server started', { port: 3000 });
 *   logger.error('Something went wrong', { err: err.message });
 */

const LOG_LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

const MIN_LEVEL = (
  process.env.LOG_LEVEL?.toLowerCase() in LOG_LEVEL_PRIORITY
    ? process.env.LOG_LEVEL.toLowerCase()
    : 'info'
);

const MIN_PRIORITY = LOG_LEVEL_PRIORITY[MIN_LEVEL];

/**
 * Write a single structured log line.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function _write(level, message, extra) {
  if (LOG_LEVEL_PRIORITY[level] < MIN_PRIORITY) return;

  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  const line = JSON.stringify(entry) + '\n';

  if (level === 'warn' || level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  /** @param {string} message @param {Record<string, unknown>} [extra] */
  debug:  (message, extra) => _write('debug', message, extra),
  /** @param {string} message @param {Record<string, unknown>} [extra] */
  info:   (message, extra) => _write('info',  message, extra),
  /** @param {string} message @param {Record<string, unknown>} [extra] */
  warn:   (message, extra) => _write('warn',  message, extra),
  /** @param {string} message @param {Record<string, unknown>} [extra] */
  error:  (message, extra) => _write('error', message, extra),
};
