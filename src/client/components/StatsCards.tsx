import type { Stats } from '@shared/types'

interface StatsCardsProps {
  stats: Stats | null
}

export default function StatsCards({ stats }: StatsCardsProps) {
  if (!stats) {
    return (
      <div className="stats-cards">
        <div className="stats-card">Loading...</div>
      </div>
    )
  }

  return (
    <div className="stats-cards">
      <div className="stats-card">
        <div className="stats-label">Active</div>
        <div className="stats-value">{stats.activeSessions}</div>
      </div>
      <div className="stats-card">
        <div className="stats-label">Pending</div>
        <div className="stats-value">{stats.pendingReviews}</div>
      </div>
      <div className="stats-card">
        <div className="stats-label">Completed</div>
        <div className="stats-value">{stats.completedToday}</div>
      </div>
      <div className="stats-card">
        <div className="stats-label">Failed</div>
        <div className="stats-value">{stats.failedToday}</div>
      </div>
      <style>{`
        .stats-cards {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px;
        }
        .stats-card {
          flex: 1 1 calc(50% - 4px);
          min-width: 100px;
          padding: 8px;
          background: var(--bg-secondary, #f5f5f5);
          border-radius: 4px;
          text-align: center;
        }
        .stats-label {
          font-size: 11px;
          color: var(--text-secondary, #666);
          margin-bottom: 4px;
        }
        .stats-value {
          font-size: 20px;
          font-weight: 600;
          color: var(--text-primary, #333);
        }
      `}</style>
    </div>
  )
}
