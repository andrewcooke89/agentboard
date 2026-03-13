// WU-002 — Settings Store AI extensions tests
// Tests: settingsStore-ai
// Covers: AC-002-6

import { beforeEach, describe, expect, test } from 'bun:test'

// localStorage mock (must precede store import for consistent behavior)
import { storage } from './localStorageMock'

import { useSettingsStore } from '../settingsStore'

beforeEach(() => {
  storage.clear()
  // Reset AI-specific fields to defaults between tests.
  // These fields do not yet exist — tests will fail until implemented.
  const state = useSettingsStore.getState()
  if ('setCronAiEnabled' in state) {
    ;(state as any).setCronAiEnabled(true)
    ;(state as any).setCronAiDrawerWidth(480)
    ;(state as any).setCronAiAutoGreet(true)
    ;(state as any).setCronAiProposalTimeout(300000)
  }
})


// ─── AC-002-6: AI settings defaults and setters ─────────────────────────────

describe('settingsStore AI extensions (AC-002-6)', () => {
  // ── cronAiEnabled ───────────────────────────────────────────────────────

  test('cronAiEnabled defaults to true', () => {
    const state = useSettingsStore.getState() as any
    expect(state.cronAiEnabled).toBe(true)
  })

  test('setCronAiEnabled sets to false', () => {
    const state = useSettingsStore.getState() as any
    state.setCronAiEnabled(false)
    expect((useSettingsStore.getState() as any).cronAiEnabled).toBe(false)
  })

  test('setCronAiEnabled sets back to true', () => {
    const state = useSettingsStore.getState() as any
    state.setCronAiEnabled(false)
    state.setCronAiEnabled(true)
    expect((useSettingsStore.getState() as any).cronAiEnabled).toBe(true)
  })

  // ── cronAiDrawerWidth ───────────────────────────────────────────────────

  test('cronAiDrawerWidth defaults to 480', () => {
    expect((useSettingsStore.getState() as any).cronAiDrawerWidth).toBe(480)
  })

  test('setCronAiDrawerWidth updates width', () => {
    ;(useSettingsStore.getState() as any).setCronAiDrawerWidth(600)
    expect((useSettingsStore.getState() as any).cronAiDrawerWidth).toBe(600)
  })

  test('setCronAiDrawerWidth accepts boundary values', () => {
    ;(useSettingsStore.getState() as any).setCronAiDrawerWidth(360)
    expect((useSettingsStore.getState() as any).cronAiDrawerWidth).toBe(360)

    ;(useSettingsStore.getState() as any).setCronAiDrawerWidth(640)
    expect((useSettingsStore.getState() as any).cronAiDrawerWidth).toBe(640)
  })

  // ── cronAiAutoGreet ─────────────────────────────────────────────────────

  test('cronAiAutoGreet defaults to true', () => {
    expect((useSettingsStore.getState() as any).cronAiAutoGreet).toBe(true)
  })

  test('setCronAiAutoGreet sets to false', () => {
    ;(useSettingsStore.getState() as any).setCronAiAutoGreet(false)
    expect((useSettingsStore.getState() as any).cronAiAutoGreet).toBe(false)
  })

  test('setCronAiAutoGreet sets back to true', () => {
    ;(useSettingsStore.getState() as any).setCronAiAutoGreet(false)
    ;(useSettingsStore.getState() as any).setCronAiAutoGreet(true)
    expect((useSettingsStore.getState() as any).cronAiAutoGreet).toBe(true)
  })

  // ── cronAiProposalTimeout ───────────────────────────────────────────────

  test('cronAiProposalTimeout defaults to 300000 (5 minutes)', () => {
    expect((useSettingsStore.getState() as any).cronAiProposalTimeout).toBe(300000)
  })

  test('setCronAiProposalTimeout updates timeout', () => {
    ;(useSettingsStore.getState() as any).setCronAiProposalTimeout(600000)
    expect((useSettingsStore.getState() as any).cronAiProposalTimeout).toBe(600000)
  })

  test('setCronAiProposalTimeout accepts zero', () => {
    ;(useSettingsStore.getState() as any).setCronAiProposalTimeout(0)
    expect((useSettingsStore.getState() as any).cronAiProposalTimeout).toBe(0)
  })

  // ── All fields exist on state ───────────────────────────────────────────

  test('all four AI settings fields exist on store state', () => {
    const state = useSettingsStore.getState()
    expect('cronAiEnabled' in state).toBe(true)
    expect('cronAiDrawerWidth' in state).toBe(true)
    expect('cronAiAutoGreet' in state).toBe(true)
    expect('cronAiProposalTimeout' in state).toBe(true)
  })

  test('all four AI setter functions exist on store state', () => {
    const state = useSettingsStore.getState()
    expect(typeof (state as any).setCronAiEnabled).toBe('function')
    expect(typeof (state as any).setCronAiDrawerWidth).toBe('function')
    expect(typeof (state as any).setCronAiAutoGreet).toBe('function')
    expect(typeof (state as any).setCronAiProposalTimeout).toBe('function')
  })
})
