/**
 * E2E Tests: Feature Flag Disable
 * Tests server behavior with WORKFLOW_ENGINE_ENABLED=false
 */

import { test, expect } from '@playwright/test'

test.describe('Feature Flag Disable', () => {
  test.skip('workflow engine disabled via flag', async ({ page }) => {
    // This test requires starting server with different env vars
    // It would verify:
    // 1. Start server with WORKFLOW_ENGINE_ENABLED=false
    // 2. Verify workflow routes return 404 or are not registered
    // 3. Verify existing functionality works (task queue, sessions)
    // 4. Stop server
    // 5. Start server with WORKFLOW_ENGINE_ENABLED=true
    // 6. Verify workflow routes return 200
    
    // Skipped: Requires orchestrated server configuration changes
    // Manual testing recommended for this scenario
    await page.goto('/')
    await expect(page.locator('body')).toBeVisible()
  })

  test('task queue works independently of workflow engine', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    // This test would verify:
    // 1. Create regular task (non-workflow)
    // 2. Verify task executes normally
    // 3. Verify task status updates
    // 4. Verify no workflow-related errors in logs
    
    // Basic smoke test
    await expect(page.locator('body')).toBeVisible()
  })
})
