/**
 * Logger module for cloud-llm-hub
 *
 * Provides a unified logger interface wrapping @mcp-abap-adt/logger
 * with additional CSRF and TLS logging methods for compatibility
 */

import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { defaultLogger } from '@mcp-abap-adt/logger';

/**
 * Extended logger interface with CSRF and TLS methods
 */
export interface ExtendedLogger extends ILogger {
  csrfToken: (
    action: 'fetch' | 'retry' | 'success' | 'error',
    message: string,
    meta?: unknown,
  ) => void;
  tlsConfig: (rejectUnauthorized: boolean) => void;
}

/**
 * Logger instance with extended methods for CSRF and TLS logging
 */
export const logger: ExtendedLogger = {
  info: (message: string, meta?: unknown) => {
    defaultLogger.info(message, meta);
  },
  error: (message: string, meta?: unknown) => {
    defaultLogger.error(message, meta);
  },
  warn: (message: string, meta?: unknown) => {
    defaultLogger.warn(message, meta);
  },
  debug: (message: string, meta?: unknown) => {
    defaultLogger.debug(message, meta);
  },
  csrfToken: (
    action: 'fetch' | 'retry' | 'success' | 'error',
    message: string,
    meta?: unknown,
  ) => {
    defaultLogger.debug(`[CSRF:${action}] ${message}`, meta);
  },
  tlsConfig: (rejectUnauthorized: boolean) => {
    defaultLogger.debug(`[TLS] rejectUnauthorized: ${rejectUnauthorized}`);
  },
};

/**
 * Logger adapter implementing ILogger interface
 * Use this when passing to @mcp-abap-adt/connection or other packages
 */
export const loggerAdapter: ILogger = {
  info: (message: string, meta?: unknown) => logger.info(message, meta),
  error: (message: string, meta?: unknown) => logger.error(message, meta),
  warn: (message: string, meta?: unknown) => logger.warn(message, meta),
  debug: (message: string, meta?: unknown) => logger.debug(message, meta),
};
