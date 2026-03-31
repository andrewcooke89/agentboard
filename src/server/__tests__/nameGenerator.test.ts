import { afterEach, describe, expect, test } from 'bun:test'
import { generateSessionName, generateUniqueSessionName, generateDescriptiveName } from '../nameGenerator'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
})

describe('generateSessionName', () => {
  test('uses adjective and noun with hyphen', () => {
    Math.random = () => 0
    expect(generateSessionName()).toBe('bold-arch')
  })

  test('picks last entries when random is near 1', () => {
    Math.random = () => 0.999999
    expect(generateSessionName()).toBe('fresh-zone')
  })
})

describe('generateUniqueSessionName', () => {
  test('returns first name if it does not exist', () => {
    Math.random = () => 0
    const exists = () => false
    expect(generateUniqueSessionName(exists)).toBe('bold-arch')
  })

  test('retries when name already exists', () => {
    const usedNames = new Set(['bold-arch'])
    let callCount = 0
    Math.random = () => {
      callCount++
      return callCount === 1 ? 0 : 0.5
    }
    const exists = (name: string) => usedNames.has(name)
    const result = generateUniqueSessionName(exists)
    expect(result).not.toBe('bold-arch')
    expect(usedNames.has(result)).toBe(false)
  })

  test('falls back to timestamp suffix after max retries', () => {
    const exists = () => true // All names exist
    const result = generateUniqueSessionName(exists)
    expect(result).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]+$/)
  })
})

describe('generateDescriptiveName', () => {
  test('extracts last directory and appends timestamp', () => {
    const result = generateDescriptiveName('/Users/me/projects/brain-state')
    // Should be like: brain-state-14h32
    expect(result).toMatch(/^brain-state-\d{2}h\d{2}$/)
  })

  test('strips trailing slashes', () => {
    const result = generateDescriptiveName('/Users/me/projects/brain-state/')
    expect(result).toMatch(/^brain-state-\d{2}h\d{2}$/)
  })

  test('sanitizes special characters to hyphens', () => {
    const result = generateDescriptiveName('/Users/me/my project (v2)')
    // "my project (v2)" -> "my-project--v2-" -> "my-project-v2" after cleanup
    expect(result).toMatch(/^my-project-v2-\d{2}h\d{2}$/)
  })

  test('truncates long directory names to 20 chars', () => {
    const result = generateDescriptiveName('/Users/me/this-is-a-really-long-directory-name-that-should-be-truncated')
    // Verify timestamp suffix and truncation
    const parts = result.split('-')
    const timestamp = parts.pop()
    expect(timestamp).toMatch(/^\d{2}h\d{2}$/)
    // Rejoin the name part (everything before timestamp)
    const namePart = result.replace(/-\d{2}h\d{2}$/, '')
    expect(namePart.length).toBeLessThanOrEqual(20)
  })

  test('falls back to random name for root path', () => {
    const result = generateDescriptiveName('/')
    // Should be like: adjective-noun-14h32
    expect(result).toMatch(/^[a-z]+-[a-z]+-\d{2}h\d{2}$/)
  })

  test('falls back to random name for tilde path', () => {
    const result = generateDescriptiveName('~')
    expect(result).toMatch(/^[a-z]+-[a-z]+-\d{2}h\d{2}$/)
  })

  test('lowercases the directory name', () => {
    const result = generateDescriptiveName('/Users/me/MyProject')
    expect(result).toMatch(/^myproject-\d{2}h\d{2}$/)
  })
})
