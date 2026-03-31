import { Hono } from 'hono'
import type { DashboardStats } from '../shared/dashboardTypes'

export function registerStatsRoutes(
  app: Hono,
  getStats: () => DashboardStats
): void {
  app.get('/api/stats', (c) => {
    return c.json(getStats())
  })
}
