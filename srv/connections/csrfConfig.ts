/**
 * Shared CSRF Token Configuration
 * 
 * This file centralizes CSRF token fetching parameters to ensure consistency
 * between different connection implementations:
 * - @mcp-abap-adt/connection: axios-based (Basic/JWT direct connections)
 * - CloudSdkAbapConnection: Cloud SDK-based (BTP Destination connections)
 * 
 * NOTE: While the implementations differ (axios vs Cloud SDK), the retry logic
 * and timeout parameters should be synchronized for consistent behavior.
 */

/**
 * CSRF token configuration constants
 * 
 * These values are synchronized with mcp-abap-adt's connection implementation.
 * If mcp-abap-adt exports CSRF_CONFIG in the future, we should use that instead.
 */
export const CSRF_CONFIG = {
  /**
   * Number of retry attempts for CSRF token fetch
   * Default: 3 attempts (total of 4 requests: initial + 3 retries)
   */
  RETRY_COUNT: 3,

  /**
   * Delay between retry attempts (milliseconds)
   * Default: 1000ms (1 second)
   */
  RETRY_DELAY: 1000,

  /**
   * CSRF token endpoint path
   * Standard SAP ADT discovery endpoint for CSRF token
   */
  ENDPOINT: '/sap/bc/adt/discovery',

  /**
   * Required headers for CSRF token fetch
   */
  REQUIRED_HEADERS: {
    'x-csrf-token': 'fetch',
    'Accept': 'application/atomsvc+xml'
  }
} as const;

/**
 * CSRF token error messages
 * Synchronized with mcp-abap-adt for consistent error reporting
 */
export const CSRF_ERROR_MESSAGES = {
  FETCH_FAILED: (attempts: number, cause: string) =>
    `Failed to fetch CSRF token after ${attempts} attempts: ${cause}`,
  
  NOT_IN_HEADERS: 'No CSRF token in response headers',
  
  REQUIRED_FOR_MUTATION: 'CSRF token is required for POST/PUT requests but could not be fetched'
} as const;

