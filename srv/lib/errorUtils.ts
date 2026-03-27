/**
 * Error Handling Utilities
 *
 * Synchronized with mcp-abap-adt error handling patterns for consistent
 * error logging and formatting across cloud-llm-hub.
 *
 * Based on logErrorSafely from @fr0ster/mcp-abap-adt/src/lib/utils.ts
 */

import type { ILogger } from '@mcp-abap-adt/connection';

/**
 * Safely extracts error information without circular references
 * Handles AxiosError, Error, and other types
 */
export interface SafeErrorDetails {
  message: string;
  status?: number;
  statusText?: string;
  responseData?: string;
  responseHeaders?: Record<string, unknown>;
  stack?: string;
  code?: string;
  name?: string;
  rawError?: string;
}

/**
 * Safely extracts error details from any error type
 * Avoids circular references and handles AxiosError specially
 */
// biome-ignore lint/suspicious/noExplicitAny: Error handling needs to accept any error type
export function extractErrorDetails(error: any): SafeErrorDetails {
  const details: SafeErrorDetails = {
    message: 'Unknown error',
  };

  // Handle HTTP errors (from axios or Cloud SDK)
  if (error?.response || (error?.statusCode && error?.config)) {
    // Cloud SDK errors have similar structure to AxiosError
    const status = error.response?.status || error.statusCode;
    const statusText =
      error.response?.statusText || error.statusText || error.message;

    details.status = status;
    details.statusText = statusText;
    details.message = error.message || statusText || 'HTTP request failed';
    details.responseHeaders = error.response?.headers || error.headers;

    // Safely extract response data
    if (error.response?.data) {
      if (typeof error.response.data === 'string') {
        details.responseData = error.response.data.substring(0, 500);
      } else {
        try {
          details.responseData = JSON.stringify(error.response.data).substring(
            0,
            500,
          );
        } catch (_e) {
          details.responseData = String(error.response.data).substring(0, 500);
        }
      }
    } else if (error.data) {
      // Cloud SDK might have data directly
      if (typeof error.data === 'string') {
        details.responseData = error.data.substring(0, 500);
      } else {
        try {
          details.responseData = JSON.stringify(error.data).substring(0, 500);
        } catch (_e) {
          details.responseData = String(error.data).substring(0, 500);
        }
      }
    }
  } else if (error instanceof Error) {
    // Standard Error object
    details.message = error.message;
    details.stack = error.stack;
    details.name = error.name;
    details.code = (error as { code?: string }).code;
  } else {
    // Other types
    try {
      details.rawError = JSON.stringify(error).substring(0, 500);
      details.message = String(error).substring(0, 200);
    } catch (_e) {
      details.rawError = String(error).substring(0, 500);
      details.message = String(error).substring(0, 200);
    }
  }

  return details;
}

/**
 * Safely logs an error without circular reference issues
 * Synchronized with logErrorSafely from mcp-abap-adt
 *
 * @param logger - Logger instance (cds.log() or compatible)
 * @param operationName - Name of the operation that failed
 * @param error - Error object to log
 * @param context - Additional context to include in log
 */
export function logErrorSafely(
  logger: ILogger | { error: (message: string, meta?: unknown) => void },
  operationName: string,
  // biome-ignore lint/suspicious/noExplicitAny: Error handling needs to accept any error type
  error: any,
  context?: Record<string, unknown>,
): void {
  if (!logger?.error) {
    return;
  }

  const details = extractErrorDetails(error);
  let errorMessage = `[ERROR] ${operationName} failed`;

  // Build error message with status if available
  if (details.status) {
    errorMessage += ` - Status: ${details.status}`;
    if (details.statusText) {
      errorMessage += ` - StatusText: ${details.statusText}`;
    }
  } else if (details.message) {
    errorMessage += `: ${details.message}`;
  }

  // Build error details object
  const errorDetails: Record<string, unknown> = {
    operation: operationName,
    ...details,
    ...context,
  };

  // Remove undefined values
  Object.keys(errorDetails).forEach((key) => {
    if (errorDetails[key] === undefined) {
      delete errorDetails[key];
    }
  });

  logger.error(errorMessage, errorDetails);
}

/**
 * Formats error message for user-facing responses
 * Extracts safe, readable error message without technical details
 */
// biome-ignore lint/suspicious/noExplicitAny: Error handling needs to accept any error type
export function formatErrorMessage(error: any): string {
  const details = extractErrorDetails(error);

  // For HTTP errors, provide user-friendly message
  if (details.status) {
    if (details.status >= 500) {
      return `Server error (${details.status}): ${details.statusText || 'Internal server error'}`;
    } else if (details.status === 401) {
      return 'Authentication failed: Invalid credentials or token expired';
    } else if (details.status === 403) {
      return 'Authorization failed: Insufficient permissions';
    } else if (details.status === 404) {
      return 'Resource not found';
    } else {
      return `Request failed (${details.status}): ${details.statusText || details.message}`;
    }
  }

  // For DNS/network errors
  if (details.code === 'ENOTFOUND' || details.message?.includes('ENOTFOUND')) {
    return 'Network error: Cannot resolve hostname. Please check your network connection and DNS settings.';
  }

  if (
    details.code === 'ECONNREFUSED' ||
    details.message?.includes('ECONNREFUSED')
  ) {
    return 'Connection refused: The server is not accepting connections. Please check if the service is running.';
  }

  // Default to error message
  return details.message || 'An unexpected error occurred';
}

/**
 * Creates a structured error response for MCP protocol
 * Similar to return_error from mcp-abap-adt
 */
export function createErrorResponse(
  // biome-ignore lint/suspicious/noExplicitAny: Error handling needs to accept any error type
  error: any,
  operationName?: string,
): {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
} {
  const message = formatErrorMessage(error);
  const details = extractErrorDetails(error);

  let errorText = message;

  // Add operation context if provided
  if (operationName) {
    errorText = `${operationName} failed: ${errorText}`;
  }

  // Add status code if available
  if (details.status) {
    errorText += ` (HTTP ${details.status})`;
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Error: ${errorText}`,
      },
    ],
  };
}
