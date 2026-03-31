import { describe, expect, test } from 'bun:test'
import {
  isValidSessionId,
  isValidTmuxTarget,
  escapeForDoubleQuotedShell,
  sanitizeForLog,
  MAX_FIELD_LENGTH,
} from '../validators'

describe('isValidSessionId', () => {
  test('accepts valid session ids', () => {
    expect(isValidSessionId('abc-123')).toBe(true)
    expect(isValidSessionId('session_01')).toBe(true)
    expect(isValidSessionId('a.b:c@d')).toBe(true)
  })

  test('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false)
  })

  test('rejects strings exceeding max length', () => {
    expect(isValidSessionId('a'.repeat(MAX_FIELD_LENGTH + 1))).toBe(false)
  })

  test('rejects invalid characters', () => {
    expect(isValidSessionId('foo bar')).toBe(false)
    expect(isValidSessionId('foo/bar')).toBe(false)
    expect(isValidSessionId('foo$bar')).toBe(false)
  })
})

describe('isValidTmuxTarget', () => {
  test('accepts valid tmux targets', () => {
    expect(isValidTmuxTarget('session:@0')).toBe(true)
    expect(isValidTmuxTarget('agentboard:window1')).toBe(true)
    expect(isValidTmuxTarget('@3')).toBe(true)
  })

  test('rejects empty string', () => {
    expect(isValidTmuxTarget('')).toBe(false)
  })
})

describe('escapeForDoubleQuotedShell', () => {
  test('escapes backslashes', () => {
    expect(escapeForDoubleQuotedShell('a\\b')).toBe('a\\\\b')
  })

  test('escapes double quotes', () => {
    expect(escapeForDoubleQuotedShell('say "hello"')).toBe('say \\"hello\\"')
  })

  test('escapes dollar signs', () => {
    expect(escapeForDoubleQuotedShell('$HOME')).toBe('\\$HOME')
    expect(escapeForDoubleQuotedShell('$(whoami)')).toBe('\\$(whoami)')
  })

  test('escapes backticks', () => {
    expect(escapeForDoubleQuotedShell('`whoami`')).toBe('\\`whoami\\`')
  })

  test('escapes exclamation marks', () => {
    expect(escapeForDoubleQuotedShell('hello!')).toBe('hello\\!')
  })

  test('handles all special characters combined', () => {
    const input = 'Run $cmd "test" with `backtick` and \\path!'
    const expected = 'Run \\$cmd \\"test\\" with \\`backtick\\` and \\\\path\\!'
    expect(escapeForDoubleQuotedShell(input)).toBe(expected)
  })

  test('passes through safe characters unchanged', () => {
    const safe = "Hello world, this is a normal prompt with no special chars."
    expect(escapeForDoubleQuotedShell(safe)).toBe(safe)
  })

  test('handles empty string', () => {
    expect(escapeForDoubleQuotedShell('')).toBe('')
  })

  test('handles single quotes (no escaping needed in double quotes)', () => {
    expect(escapeForDoubleQuotedShell("it's fine")).toBe("it's fine")
  })
})

describe('sanitizeForLog', () => {
  test('removes control characters', () => {
    expect(sanitizeForLog('hello\x00world')).toBe('helloworld')
    expect(sanitizeForLog('test\x1Bdata')).toBe('testdata')
    expect(sanitizeForLog('foo\x7Fbar')).toBe('foobar')
  })

  test('escapes newlines', () => {
    expect(sanitizeForLog('line1\nline2')).toBe('line1\\nline2')
    // \r is removed as control char, then \n is escaped
    expect(sanitizeForLog('line1\r\nline2')).toBe('line1\\nline2')
  })

  test('removes ANSI escape codes', () => {
    expect(sanitizeForLog('\x1B[31mred text\x1B[0m')).toBe('[31mred text[0m')
  })

  test('truncates long strings', () => {
    const longString = 'a'.repeat(1500)
    const result = sanitizeForLog(longString)
    expect(result.length).toBe(1000)
    expect(result.endsWith('...')).toBe(true)
  })

  test('handles null and undefined', () => {
    expect(sanitizeForLog(null)).toBe('')
    expect(sanitizeForLog(undefined)).toBe('')
  })

  test('handles empty string', () => {
    expect(sanitizeForLog('')).toBe('')
  })

  test('preserves safe characters', () => {
    const safe = 'Hello world! This is a normal log message with numbers 123.'
    expect(sanitizeForLog(safe)).toBe(safe)
  })

  test('prevents log injection via newlines', () => {
    const malicious = 'user input\n[ERROR] FAKE ERROR MESSAGE'
    expect(sanitizeForLog(malicious)).toBe('user input\\n[ERROR] FAKE ERROR MESSAGE')
  })

  test('preserves tab characters', () => {
    // Tab (0x09) is excluded from control character removal
    expect(sanitizeForLog('hello\tworld')).toBe('hello\tworld')
  })
})
