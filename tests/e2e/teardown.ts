/**
 * Global teardown for Playwright e2e tests
 * Cleans up tmux sessions created during testing
 */

import { killTmuxSession } from './helpers'

export default async function globalTeardown() {
  const tmuxSession = process.env.E2E_TMUX_SESSION
  
  if (tmuxSession) {
    console.log(`[E2E Teardown] Cleaning up tmux session: ${tmuxSession}`)
    killTmuxSession(tmuxSession)
  }
}
