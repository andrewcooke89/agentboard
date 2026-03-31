import { useTicketStore } from '../../stores/ticketStore'

export default function TicketStatsBar() {
  const stats = useTicketStore(s => s.stats)
  const tickets = useTicketStore(s => s.tickets)

  if (!stats) return null

  const open = stats.by_status?.open ?? 0
  const resolved = stats.resolved_this_week ?? 0
  const blocked = tickets.filter(t => t.is_blocked).length

  return (
    <div className="flex items-center gap-4 text-sm">
      <StatBadge label="Open" value={open} color="text-yellow-400" />
      <StatBadge label="Resolved/wk" value={resolved} color="text-green-400" />
      {blocked > 0 && <StatBadge label="Blocked" value={blocked} color="text-red-400" />}
      <div className="ml-auto text-xs text-[var(--text-secondary)]">
        Avg age: {Math.round(stats.average_age_days ?? 0)}d
        {stats.oldest_open && ` | Oldest: ${stats.oldest_open.id} (${stats.oldest_open.age_days}d)`}
      </div>
    </div>
  )
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-lg font-semibold ${color}`}>{value}</span>
      <span className="text-[var(--text-secondary)]">{label}</span>
    </div>
  )
}
