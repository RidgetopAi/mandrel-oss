/**
 * Lightweight frontend logger.
 *
 * Mirrors the `console` API (same method names + variadic signatures) so call
 * sites read identically. In production, low-signal levels (log / info / debug)
 * are suppressed to keep the browser console quiet; warn and error always emit
 * so real problems remain visible (and can be wired to Sentry here later).
 *
 * Usage: `import { logger } from '../utils/logger';` then `logger.error(...)`.
 */
const isProd = import.meta.env.PROD;

export const logger = {
  log: (...args: unknown[]): void => {
    if (!isProd) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    if (!isProd) console.info(...args);
  },
  debug: (...args: unknown[]): void => {
    if (!isProd) console.debug(...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};

export default logger;
