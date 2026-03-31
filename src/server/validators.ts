// validators.ts - Input validation utilities for session and tmux operations

export const MAX_FIELD_LENGTH = 4096
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:@-]+$/
export const TMUX_TARGET_PATTERN =
  /^(?:[A-Za-z0-9_.-]+:)?(?:@[0-9]+|[A-Za-z0-9_.-]+)$/

/**
 * Validates a session ID against allowed character patterns and length constraints.
 * Session IDs must contain only alphanumeric characters, underscores, periods, colons, @ symbols, and hyphens.
 *
 * @param {string} sessionId - The session ID to validate
 * @returns {boolean} True if the session ID is valid, false otherwise
 * @example
 * isValidSessionId('abc-123')      // true
 * isValidSessionId('session_01')   // true
 * isValidSessionId('foo bar')      // false (contains space)
 */
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length > MAX_FIELD_LENGTH) {
    return false
  }
  return SESSION_ID_PATTERN.test(sessionId)
}

export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * Validates a task ID against allowed character patterns and length constraints.
 * Task IDs must contain only alphanumeric characters, underscores, and hyphens.
 *
 * @param {string} taskId - The task ID to validate
 * @returns {boolean} True if the task ID is valid, false otherwise
 */
export function isValidTaskId(taskId: string): boolean {
  if (!taskId || taskId.length > MAX_FIELD_LENGTH) {
    return false
  }
  return TASK_ID_PATTERN.test(taskId)
}

export function isValidTmuxTarget(target: string): boolean {
  if (!target || target.length > MAX_FIELD_LENGTH) {
    return false
  }
  return TMUX_TARGET_PATTERN.test(target)
}

/**
 * Escape a string for safe inclusion inside double quotes in a shell command.
 * Handles all characters that have special meaning inside double-quoted strings
 * in POSIX sh / bash: backslash, double-quote, dollar, backtick, and exclamation mark.
 */
export function escapeForDoubleQuotedShell(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!')
}

/**
 * Sanitize user-supplied data for safe logging.
 * Prevents log injection via newlines, ANSI escape codes, and control characters.
 * Truncates to 1000 chars to prevent log bloat.
 */
export function sanitizeForLog(value: string | null | undefined): string {
  if (!value) return ''

  let sanitized = String(value)
    // Remove control characters (0x00-0x1F except tab, 0x7F-0x9F)
    // eslint-disable-next-line no-control-regex -- Intentionally matching control characters for security sanitization
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
    // Replace newlines with escaped representation
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')

  // Truncate to max length
  if (sanitized.length > 1000) {
    sanitized = sanitized.slice(0, 997) + '...'
  }

  return sanitized
}
